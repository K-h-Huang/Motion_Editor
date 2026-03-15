function normalizeObjectNameForWarning(objectName: string | null | undefined): string {
  const normalized = (objectName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '');
  return normalized || 'xxx';
}

export function formatMissingObjectModelWarning(objectName: string | null | undefined): string {
  const normalizedName = normalizeObjectNameForWarning(objectName);
  return `Motion file contains object tracks, but no matching OBJ model named "${normalizedName}" was found, so object motion is ignored.`;
}
