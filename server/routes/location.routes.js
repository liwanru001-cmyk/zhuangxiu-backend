const express = require('express');
const auth = require('../middleware/auth');
const asyncHandler = require('../utils/async-handler');
const { success, error } = require('../utils/response');

const router = express.Router();

function parsePoint(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const parts = value.split(',').map((item) => Number(item.trim()));
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      return { longitude: parts[0], latitude: parts[1] };
    }
  }
  if (typeof value === 'object') {
    const longitude = Number(value.lon ?? value.lng ?? value.longitude);
    const latitude = Number(value.lat ?? value.latitude);
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
      return { longitude, latitude };
    }
  }
  return null;
}

function normalizePoi(poi) {
  const point =
    parsePoint(poi.lonlat) ||
    parsePoint(poi.location) ||
    parsePoint({ lon: poi.lon, lat: poi.lat });
  if (!point) return null;
  const name = String(poi.name || poi.poiName || poi.hotPointName || '').trim();
  const address = String(poi.address || poi.addressDetail || poi.detailAddress || '').trim();
  return {
    name: name || address || '地图位置',
    address: address || name,
    longitude: point.longitude,
    latitude: point.latitude,
    provider: 'tianditu',
  };
}

async function requestTiandituSearch(keyword, key) {
  const postStr = JSON.stringify({
    keyWord: keyword,
    queryType: '1',
    start: '0',
    count: '10',
    level: '12',
    mapBound: '73.66,3.86,135.05,53.55',
  });
  const url = new URL('https://api.tianditu.gov.cn/v2/search');
  url.searchParams.set('postStr', postStr);
  url.searchParams.set('type', 'query');
  url.searchParams.set('tk', key);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return response.json();
}

async function requestTiandituGeocoder(keyword, key) {
  const url = new URL('https://api.tianditu.gov.cn/geocoder');
  url.searchParams.set('ds', JSON.stringify({ keyWord: keyword }));
  url.searchParams.set('tk', key);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return response.json();
}

function normalizeSearchPayload(payload) {
  const pois = Array.isArray(payload?.pois) ? payload.pois : [];
  return pois.map(normalizePoi).filter(Boolean);
}

function normalizeGeocoderPayload(payload) {
  const location = payload?.location || payload?.result?.location;
  const point = parsePoint(location);
  if (!point) return [];
  const result = payload?.result || payload || {};
  const name = String(result.formatted_address || result.addressComponent?.address || '').trim();
  return [
    {
      name: name || '地图位置',
      address: name,
      longitude: point.longitude,
      latitude: point.latitude,
      provider: 'tianditu',
    },
  ];
}

router.get(
  '/search',
  asyncHandler(auth),
  asyncHandler(async (req, res) => {
    const keyword = String(req.query.keyword || '').trim();
    if (keyword.length < 2) return error(res, '请输入更完整的地址关键词', 400);

    const key = process.env.TIANDITU_WEB_SERVICE_KEY || process.env.TIANDITU_API_KEY || '';
    if (!key) return error(res, '天地图服务密钥未配置', 503);

    const searchPayload = await requestTiandituSearch(keyword, key);
    let items = normalizeSearchPayload(searchPayload);
    if (!items.length) {
      const geocoderPayload = await requestTiandituGeocoder(keyword, key);
      items = normalizeGeocoderPayload(geocoderPayload);
    }
    return success(res, { items });
  })
);

module.exports = router;
