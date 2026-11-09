export const MODES = [
  { id: "interview", label: "Entrevista" },
  { id: "learning", label: "Aprendizado" },
];

export const DEFAULT_MODE = "interview";

const byId = new Map(MODES.map((mode) => [mode.id, mode]));

export function resolveMode(value) {
  if (typeof value !== "string") return null;
  return byId.get(value.trim().toLowerCase()) ?? null;
}
