const { latLngToCell, cellToBoundary, gridDisk, cellToLatLng, isValidCell } = require("h3-js");

/**
 * Computes the average centroid (lat/lng) of a set of H3 cells.
 * Returns null if no valid cells are given.
 */
function cellsCentroid(cells = []) {
  const valid = (Array.isArray(cells) ? cells : []).filter((c) => isValidCell(c));
  if (!valid.length) return null;
  let latSum = 0;
  let lngSum = 0;
  for (const cell of valid) {
    const [lat, lng] = cellToLatLng(cell);
    latSum += lat;
    lngSum += lng;
  }
  return { lat: latSum / valid.length, lng: lngSum / valid.length };
}

const H3_RESOLUTION = 7;

/**
 * Derives an H3 cell index from lat/lng coordinates.
 * Returns null if coordinates are invalid.
 */
function deriveH3Cell(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  try {
    return latLngToCell(lat, lng, H3_RESOLUTION);
  } catch {
    return null;
  }
}

/**
 * Returns all H3 cells within k rings of a center cell (inclusive).
 * k=0 → [cell], k=1 → 7 cells, k=2 → 19 cells
 */
function getH3Ring(h3Index, k = 1) {
  if (!h3Index || !isValidCell(h3Index)) return [];
  try {
    return gridDisk(h3Index, k);
  } catch {
    return [];
  }
}

/**
 * Returns H3 cells to search for a given assignment stage.
 * Stage 1 → exact cell, Stage 2 → k=1 ring, Stage 3 → k=2 ring
 */
function getH3CellsForStage(h3Index, stage) {
  if (!h3Index) return [];
  if (stage === 1) return [h3Index];
  if (stage === 2) return getH3Ring(h3Index, 1);
  return getH3Ring(h3Index, 2);
}

module.exports = {
  H3_RESOLUTION,
  deriveH3Cell,
  getH3Ring,
  getH3CellsForStage,
  cellsCentroid,
  cellToLatLng,
  isValidCell,
};
