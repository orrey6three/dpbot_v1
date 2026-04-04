/**
 * Координаты центров городов (из проекта dps_posts)
 */
export const CITIES = {
  shumikha: {
    name: "Шумиха",
    coords: [55.2255, 63.2982],
  },
  mishkino: {
    name: "Мишкино",
    coords: [55.3385, 63.9168],
  },
  shchuchye: {
    name: "Щучье",
    coords: [55.2133, 62.7634],
  },
};

export function getCityByName(name) {
  const normalized = (name || "").toLowerCase();
  if (normalized.includes("шумих")) return CITIES.shumikha;
  if (normalized.includes("мишкин")) return CITIES.mishkino;
  if (normalized.includes("щучь")) return CITIES.shchuchye;
  return null;
}
