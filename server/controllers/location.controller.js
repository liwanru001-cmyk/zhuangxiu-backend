const { success, error } = require('../utils/response');

function tiandituKey() {
  return String(
    process.env.TIANDITU_WEB_SERVICE_KEY || process.env.TIANDITU_KEY || ''
  ).trim();
}

function extractCoordinate(payload = {}) {
  const location = payload.location || payload.result?.location || {};
  const longitude = Number(
    location.lon ?? location.lng ?? location.longitude ?? location.x
  );
  const latitude = Number(location.lat ?? location.latitude ?? location.y);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return { longitude, latitude };
}

async function geocode(req, res) {
  const key = tiandituKey();
  if (!key) {
    return error(
      res,
      '天地图密钥未配置，请在服务端 .env 中填写 TIANDITU_WEB_SERVICE_KEY',
      500
    );
  }

  const address = String(req.body?.address || '').trim();
  const city = String(req.body?.city || '').trim();
  if (!address) return error(res, '请填写需要定位的地址');

  const keyword = `${city}${address}`.slice(0, 200);
  const url = new URL('https://api.tianditu.gov.cn/geocoder');
  url.searchParams.set('ds', JSON.stringify({ keyWord: keyword }));
  url.searchParams.set('tk', key);

  let payload;
  try {
    const response = await fetch(url, { method: 'GET' });
    payload = await response.json();
    if (!response.ok) {
      return error(res, '天地图定位服务暂时不可用', 502);
    }
  } catch (_) {
    return error(res, '天地图定位服务暂时不可用', 502);
  }

  const coordinate = extractCoordinate(payload);
  if (!coordinate) {
    return error(res, '未找到该地址，请补充更详细的门牌号或地标');
  }

  return success(res, {
    provider: 'tianditu',
    longitude: coordinate.longitude,
    latitude: coordinate.latitude,
    formatted_address:
      payload.formatted_address ||
      payload.result?.formatted_address ||
      payload.address ||
      keyword,
  });
}

async function search(req, res) {
  const key = tiandituKey();
  if (!key) {
    return error(
      res,
      '天地图密钥未配置，请在服务端 .env 中填写 TIANDITU_WEB_SERVICE_KEY',
      500
    );
  }

  const keyword = String(req.body?.keyword || req.body?.address || '').trim();
  const city = String(req.body?.city || '').trim();
  if (!keyword) return error(res, '请输入要搜索的地址');

  const url = new URL('https://api.tianditu.gov.cn/geocoder');
  const searchText = `${city}${keyword}`.slice(0, 200);
  url.searchParams.set('ds', JSON.stringify({ keyWord: searchText }));
  url.searchParams.set('tk', key);

  let payload;
  try {
    const response = await fetch(url, { method: 'GET' });
    payload = await response.json();
    if (!response.ok) {
      return error(res, '天地图搜索服务暂时不可用', 502);
    }
  } catch (_) {
    return error(res, '天地图搜索服务暂时不可用', 502);
  }

  const coordinate = extractCoordinate(payload);
  if (!coordinate) {
    return error(res, '未找到该地址，请换一个关键词搜索');
  }

  return success(res, [
    {
      provider: 'tianditu',
      longitude: coordinate.longitude,
      latitude: coordinate.latitude,
      formatted_address:
        payload.formatted_address ||
        payload.result?.formatted_address ||
        payload.address ||
        keyword,
    },
  ]);
}

module.exports = {
  geocode,
  search,
};
