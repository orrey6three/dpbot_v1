import fetch from "node-fetch";
import { config } from "./config.js";

/**
 * Геокодирует улицу через Yandex Maps API.
 * @param {string} street
 * @param {string} [city]
 * @returns {Promise<[number, number] | null>} [lat, lon] или null
 */
export async function geocodeStreet(street, city = config.defaultCity) {
  try {
    const query = encodeURIComponent(`${city}, ${street}`);
    const url   = `https://geocode-maps.yandex.ru/1.x/?apikey=${config.yandexKey}&format=json&geocode=${query}`;

    const res = await fetch(url, { timeout: 5000 });
    if (!res.ok) throw new Error(`Yandex HTTP ${res.status}`);

    const data    = await res.json();
    const members = data.response?.GeoObjectCollection?.featureMember;
    if (!members?.length) return null;

    const pos       = members[0].GeoObject.Point.pos;
    const [lon, lat] = pos.split(" ").map(Number);
    return [lat, lon];
  } catch (err) {
    console.error(`[GEO] Failed to geocode "${street}":`, err.message);
    return null;
  }
}
