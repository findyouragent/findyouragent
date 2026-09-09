import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MIB = 1024 * 1024;

export class PersistenceError extends Error {
  constructor(message, { code = 'PERSISTENCE_ERROR', cause } = {}) {
    super(message, { cause });
    this.name = 'PersistenceError';
    this.code = code;
  }
}

export function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PersistenceError(`${name} must be a positive integer`, { code: 'PERSISTENCE_CONFIG' });
  }
  return parsed;
}

/**
 * Synchronously visit JSONL records without loading the whole file. Malformed
 * rows are reported and skipped; an oversized file fails before any partial
 * state can be mistaken for the complete durable record.
 */
export function replayJsonl(filePath, {
  maxBytes,
  onRecord,
  onMalformed = () => {},
  fsImpl = fs,
  chunkBytes = MIB,
  maxLineBytes = 4 * MIB,
} = {}) {
  let stat;
  try { stat = fsImpl.statSync(filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return { bytes: 0, records: 0, malformed: 0 };
    throw new PersistenceError(`Cannot inspect ${filePath}: ${error.message}`, { cause: error });
  }
  if (stat.size > maxBytes) {
    throw new PersistenceError(
      `${filePath} is ${stat.size} bytes, above its ${maxBytes}-byte replay ceiling; refusing a partial replay`,
      { code: 'PERSISTENCE_CAPACITY' },
    );
  }
  const fd = fsImpl.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, maxBytes)));
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let records = 0;
  let malformed = 0;
  try {
    for (;;) {
      const read = fsImpl.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      consume(decoder.write(buffer.subarray(0, read)));
    }
    consume(decoder.end());
    if (carry.trim()) {
      assertLineBound(carry);
      visit(carry.replace(/\r$/, ''));
    }
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError(`Cannot replay ${filePath}: ${error.message}`, { cause: error });
  } finally {
    fsImpl.closeSync(fd);
  }
  return { bytes: stat.size, records, malformed };

  function consume(decoded) {
    const text = carry + decoded;
    const lines = text.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      assertLineBound(line);
      visit(line.replace(/\r$/, ''));
    }
    assertLineBound(carry);
  }

  function assertLineBound(line) {
    const bytes = Buffer.byteLength(line);
    if (bytes > maxLineBytes) {
      throw new PersistenceError(
        `${filePath} contains a ${bytes}-byte row above its ${maxLineBytes}-byte replay row ceiling`,
        { code: 'PERSISTENCE_ROW_TOO_LARGE' },
      );
    }
  }

  function visit(line) {
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      malformed += 1;
      onMalformed(error, line);
      return;
    }
    // Schema, capacity, and application errors are not malformed JSON. They
    // must abort replay so a lost checkpoint cannot look like complete state.
    onRecord(value);
    records += 1;
  }
}

/**
 * Bounded synchronous appends plus atomic checkpoint replacement. Node runs
 * these sections without an await, and the explicit guard rejects accidental
 * re-entrancy. The next compaction watermark advances beyond the compacted
 * size, preventing rewrite-on-every-append when retained state is large.
 */
export function createBoundedJsonl(filePath, {
  maxBytes,
  compactAtBytes,
  growthBytes = 16 * MIB,
  maxLineBytes = 4 * MIB,
  fsImpl = fs,
} = {}) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  let fileBytes = statSize();
  let busy = false;
  let lastCleanupError = null;
  // Existing append history crosses the soft trigger on its next mutation;
  // after a successful compaction, watermark() adds hysteresis.
  let nextCompactAt = Math.min(maxBytes, Math.max(compactAtBytes, fileBytes));

  function statSize() {
    try { return fsImpl.statSync(filePath).size; }
    catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw new PersistenceError(`Cannot inspect ${filePath}: ${error.message}`, { cause: error });
    }
  }

  function watermark(size) {
    return Math.min(maxBytes, Math.max(compactAtBytes, size + growthBytes));
  }

  function encode(lines) {
    const out = [];
    let bytes = 0;
    for (const line of lines) {
      const text = typeof line === 'string' ? line : JSON.stringify(line);
      const size = Buffer.byteLength(text) + 1;
      if (size > maxLineBytes) {
        throw new PersistenceError(`A ${size}-byte persistence row exceeds the ${maxLineBytes}-byte row limit`, {
          code: 'PERSISTENCE_ROW_TOO_LARGE',
        });
      }
      out.push(text);
      bytes += size;
    }
    return { out, bytes };
  }

  function append(lines, checkpointLines) {
    const encoded = encode(lines);
    if (!encoded.out.length) return { written: 0, compacted: false };
    return locked(() => {
      if (fileBytes + encoded.bytes > nextCompactAt) {
        replace(checkpointLines());
        return { written: encoded.out.length, compacted: true };
      }
      const fd = fsImpl.openSync(filePath, fsImpl.existsSync(filePath) ? 'r+' : 'wx+');
      let committed = false;
      try {
        let position = fileBytes;
        for (const line of encoded.out) {
          const buffer = Buffer.from(`${line}\n`);
          writeFully(fd, buffer, fsImpl, position);
          position += buffer.length;
        }
        fsImpl.fsyncSync(fd);
        fileBytes += encoded.bytes;
        committed = true;
      } catch (error) {
        try {
          fsImpl.ftruncateSync(fd, fileBytes);
          fsImpl.fsyncSync(fd);
        } catch (rollbackError) {
          throw new PersistenceError(
            `Append to ${filePath} failed and its previous length could not be restored: ${rollbackError.message}`,
            { cause: error },
          );
        }
        throw new PersistenceError(`Cannot append durable data to ${filePath}: ${error.message}`, { cause: error });
      } finally {
        try { fsImpl.closeSync(fd); }
        catch (error) {
          // fsync is the commit point. A cleanup error after it must not make
          // callers roll back memory while the row is already durable.
          if (committed) lastCleanupError = String(error.message || error);
          else throw error;
        }
      }
      return { written: encoded.out.length, compacted: false };
    });
  }

  function compact(checkpointLines) {
    return locked(() => replace(checkpointLines()));
  }

  function replace(lines) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
    let fd;
    let bytes = 0;
    try {
      fd = fsImpl.openSync(temp, 'wx');
      for (const line of lines) {
        const text = typeof line === 'string' ? line : JSON.stringify(line);
        const size = Buffer.byteLength(text) + 1;
        if (size > maxLineBytes) {
          throw new PersistenceError(`A ${size}-byte checkpoint row exceeds the ${maxLineBytes}-byte row limit`, {
            code: 'PERSISTENCE_ROW_TOO_LARGE',
          });
        }
        if (bytes + size > maxBytes) {
          throw new PersistenceError(
            `Retained state cannot fit the ${maxBytes}-byte budget for ${filePath}; the write was rejected without evicting history`,
            { code: 'PERSISTENCE_CAPACITY' },
          );
        }
        writeFully(fd, Buffer.from(`${text}\n`), fsImpl);
        bytes += size;
      }
      fsImpl.fsyncSync(fd);
      fsImpl.closeSync(fd);
      fd = undefined;
      fsImpl.renameSync(temp, filePath);
      fileBytes = bytes;
      nextCompactAt = watermark(bytes);
      fsyncDirectoryBestEffort(path.dirname(filePath), fsImpl);
      return { bytes };
    } catch (error) {
      if (fd !== undefined) {
        try { fsImpl.closeSync(fd); } catch { /* retain original error */ }
      }
      try { fsImpl.unlinkSync(temp); } catch { /* temp may not exist */ }
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(`Cannot atomically replace ${filePath}: ${error.message}`, { cause: error });
    }
  }

  function locked(fn) {
    if (busy) throw new PersistenceError(`Concurrent persistence operation for ${filePath}`, { code: 'PERSISTENCE_BUSY' });
    busy = true;
    try { return fn(); } finally { busy = false; }
  }

  return {
    append,
    compact,
    status: () => ({ fileBytes, maxBytes, nextCompactAt, lastCleanupError }),
  };
}

function writeFully(fd, buffer, fsImpl, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fsImpl.writeSync(fd, buffer, offset, buffer.length - offset,
      position === null ? null : position + offset);
    if (!written) throw new Error('write returned zero bytes');
    offset += written;
  }
}

function fsyncDirectoryBestEffort(directory, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(directory, 'r');
    fsImpl.fsyncSync(fd);
  } catch { /* unsupported on some Windows/filesystem combinations */ }
  finally { if (fd !== undefined) try { fsImpl.closeSync(fd); } catch { /* best effort */ } }
}
