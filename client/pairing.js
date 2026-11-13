export function pairingLink(origin, code) {
  let url;
  try { url = new URL(origin); } catch { throw new Error('请在配对设置中填写手机可访问的 DSH 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('DSH 访问地址格式无效，请检查配对设置。');
  }
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || /^127\./.test(url.hostname)
    || ['[::1]', '0.0.0.0', '[::]'].includes(url.hostname)) {
    throw new Error('本机回环地址不可用于手机配对，请使用可访问的 DSH 地址。');
  }
  const link = new URL('voxchat://pair');
  link.searchParams.set('server', url.origin);
  link.searchParams.set('code', code);
  return link.href;
}
let lastLink, lastImage;
export function pairingImage(link, encoder) {
  if (link !== lastLink) {
    const qr = encoder(0, 'M'); qr.addData(link, 'Byte'); qr.make();
    lastImage = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }));
    lastLink = link;
  }
  return lastImage;
}
