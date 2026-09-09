// A failed document read is unknown; only a retrieved object can establish
// whether the agent published a hire menu. Accept valid cards without services.
export function hasAgentMetadata(payload) {
  return Boolean(payload && !payload.error && payload.meta
    && typeof payload.meta === 'object' && !Array.isArray(payload.meta));
}
