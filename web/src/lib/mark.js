/*
  One arm of the mark, as a path on a 0..100 grid.

  The whole mark is this shape drawn twice, the second rotated 180° about the
  centre — which is what the source artwork is. Traced from the render's
  silhouette rather than redrawn by eye: outer corners at 7% of the tile, the
  three corners of the notch nearly sharp, and the fold at exactly 45°.

  public/mark.svg and public/icon.svg carry the same path for anything that
  needs a URL instead of a component.
*/
export const MARK_PATH =
  'M33.8 25.1Q33.8 20 38.9 20L73.3 20Q80.3 20 80.3 27L80.3 56.6Q80.3 63.6 73.3 63.6L67.8 63.6Q60.8 63.6 60.8 56.6L60.8 46.4Q60.8 43.9 58.3 43.9L49.6 43.9Q47.1 43.9 45.36 42.11L35.54 31.99Q33.8 30.2 33.8 27.7Z';
