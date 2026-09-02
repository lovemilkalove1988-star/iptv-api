const express = require("express");
const router = express.Router();
// Remove obsolete pairing copy from rendered client screens without touching the flow itself.
router.use((req,res,next)=>{const send=res.send.bind(res);res.send=body=>{if(typeof body==='string'){body=body.replace(/<p[^>]*id="state"[^>]*>\s*Ожидание подключения…\s*<\/p>/g,'').replace(/<p[^>]*>\s*Ожидание подключения…\s*<\/p>/g,'').replace(/Ожидание подключения…/g,'');}return send(body);};next();});
const db = require("../database");
const crypto = require("crypto");
const QRCode = require("qrcode");
const devicePairing = require("../services/milktv-device-pairing");
// Temporary, reversible client-only switch used while validating TV navigation.
const {
  hashPassword,
  isPasswordHash,
  verifyPassword
} = require("../password-utils");

// The channel page is rendered per session and has responsive tile CSS.  Do
// not let Android/WebView reuse an older row-layout document from its cache.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});


// ===============================
// ВХОД КЛИЕНТА
// ===============================

function pairingTokenHash(token) { return devicePairing.hash(token); }
function pairingCookie(res, credential) { res.cookie('milktv_device_credential', credential, { httpOnly:true, sameSite:'lax', maxAge:10*365*24*60*60*1000 }); }
async function createPairingData(req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const code = devicePairing.pairingCode();
  const deviceName = String(req.query.name || 'TV / браузер').trim().slice(0,120) || 'TV / браузер';
  await db.query("INSERT INTO client_pairing_sessions(token_hash,pairing_code_hash,device_name,device_hint,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '5 minutes')", [pairingTokenHash(token),devicePairing.hash(code),deviceName,req.get('user-agent')?.slice(0,180)||null]);
  const approvalUrl = `${req.protocol}://${req.get('host')}/client/pair/approve/${token}`;
  const qr = await QRCode.toDataURL(approvalUrl, { margin:2, width:320 });
  return { token, code, qr };
}

function pairingWaitScript(token, stateElementId) {
  const safeToken = JSON.stringify(String(token));
  const safeStateId = JSON.stringify(String(stateElementId));
  return `<script>(function(){var token=${safeToken},state=document.getElementById(${safeStateId}),timer=null,busy=false;function message(value){if(state)state.textContent=value;}function stop(){if(timer){clearInterval(timer);timer=null;}}function finalize(){if(busy)return;busy=true;fetch('/client/pair/finalize/'+encodeURIComponent(token),{method:'POST',credentials:'same-origin'}).then(function(response){return response.json().then(function(body){return {response:response,body:body};});}).then(function(result){if(result.response.ok&&result.body&&result.body.ok){stop();message('Устройство подключено. Открываем MILK TV…');window.location.replace(result.body.redirect||'/client/channels');return;}busy=false;if(result.body&&result.body.error==='pending')return;message('Не удалось завершить подключение. Обновите страницу.');stop();}).catch(function(){busy=false;});}function check(){fetch('/client/pair/status/'+encodeURIComponent(token),{credentials:'same-origin'}).then(function(response){return response.json();}).then(function(data){if(data&&data.approved){finalize();return;}if(data&&data.expired){stop();message('Срок действия кода истёк. Обновите страницу.');return;}if(data&&data.rejected){stop();message('Подключение отменено владельцем.');}}).catch(function(){});}timer=setInterval(check,3000);check();}());</script>`;
}

router.get('/pair', async (req, res) => {
  if (req.session.viewerDevice) return res.redirect('/client/channels');
  try {
    const {token, code, qr} = await createPairingData(req);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair MILK TV</title><style>body{margin:0;padding:20px;background:#111;color:#fff;font:18px Arial;text-align:center}.box{max-width:460px;margin:auto}.qr{width:min(80vw,320px);height:auto;background:#fff;padding:10px;border-radius:12px}.code{font-size:25px;letter-spacing:4px;margin:15px}.muted{color:#aaa;font-size:14px}.recovery{display:block;margin:18px auto 0;padding:12px;border:1px solid #444;border-radius:9px;background:#1b1b1b;color:#fff;text-decoration:none;font-size:16px}</style><div class="box"><h2>Подключить TV</h2><p class="muted">Отсканируйте QR телефоном владельца аккаунта</p><img class="qr" src="${qr}" alt="QR"><div class="code" id="code">Код подключения: ${code}</div><a class="recovery" href="/client/recover">Восстановить устройство</a></div>${pairingWaitScript(token, null)}`);
  } catch (_) { res.status(500).send('Pairing unavailable'); }
});

const pairingCodeAttempts = new Map();
router.post('/pair/code', async (req, res) => {
  if (req.session.viewerDevice) return res.status(403).send('Недоступно');
  const now=Date.now(), key=(req.ip||'unknown')+':'+(req.session.client?.id||'anon');
  const attempts=(pairingCodeAttempts.get(key)||[]).filter(t=>now-t<15*60*1000);
  if (attempts.length>=8) return res.status(429).send('Слишком много попыток. Повторите позже.');
  attempts.push(now); pairingCodeAttempts.set(key, attempts);
  const code=String(req.body?.code||'').replace(/\s+/g,'').toUpperCase();
  if(!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) return res.status(400).send('Введите 6-значный код подключения.');
  try {
    const row=(await db.query('SELECT token_hash,expires_at,consumed_at FROM client_pairing_sessions WHERE pairing_code_hash=$1',[devicePairing.hash(code)])).rows[0];
    if(!row) return res.status(404).send('Код подключения не найден.');
    if(row.consumed_at) return res.status(409).send('Этот код уже использован.');
    if(new Date(row.expires_at)<=new Date()) return res.status(410).send('Срок действия кода истёк. Обновите QR-код на устройстве.');
    if (!req.session.client) return res.redirect('/login?pair_code='+encodeURIComponent(code));
    if (req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Недействительная сессия');
    return res.redirect('/client/pair/approve/by-code/'+encodeURIComponent(code));
  } catch (_) { return res.status(500).send('Не удалось проверить код подключения.'); }
});
router.get('/pair/approve/by-code/:code', (req,res) => {
  if (!req.session.client || req.session.viewerDevice) return res.status(403).send('Недоступно');
  const code=String(req.params.code||'').toUpperCase();
  db.query('SELECT expires_at,consumed_at FROM client_pairing_sessions WHERE pairing_code_hash=$1',[devicePairing.hash(code)]).then(q=>{const row=q.rows[0];if(!row)return res.status(404).send('Код подключения не найден.');if(row.consumed_at)return res.status(409).send('Этот код уже использован.');if(new Date(row.expires_at)<=new Date())return res.status(410).send('Срок действия кода истёк. Обновите QR-код на устройстве.');res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключить устройство</title><style>body{margin:0;padding:20px;background:#111;color:#fff;font:18px Arial}.box{max-width:440px;margin:auto;background:#1b1b1b;padding:22px;border-radius:14px}button{width:100%;padding:14px;margin-top:12px;border:0;border-radius:10px;background:#356a49;color:#fff;font-size:17px}</style><div class="box"><h2>Подключить устройство?</h2><p>Подтвердите добавление TV к аккаунту.</p><form method="post"><input type="hidden" name="_csrf" value="${req.session.csrfToken||''}"><button>Подключить</button></form><a href="/client" style="display:block;text-align:center;margin-top:12px;color:#aaa">Отмена</a></div>`);}).catch(()=>res.status(500).send('Не удалось открыть подтверждение.'));
});
router.post('/pair/approve/by-code/:code', async (req,res) => {
  if (!req.session.client || req.session.viewerDevice || req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Недействительная сессия');
  const client=await db.connect();
  try { await client.query('BEGIN'); const code=String(req.params.code||'').toUpperCase(); const pairing=(await client.query('SELECT * FROM client_pairing_sessions WHERE pairing_code_hash=$1 FOR UPDATE',[devicePairing.hash(code)])).rows[0]; if(!pairing||pairing.consumed_at||new Date(pairing.expires_at)<=new Date()) throw new Error('Код истёк или уже использован'); const count=Number((await client.query("SELECT COUNT(*)::int AS count FROM devices WHERE client_id=$1 AND status IN ('active','paused')",[req.session.client.id])).rows[0].count); if(count>=4) throw new Error('Достигнут лимит устройств'); const credential=devicePairing.randomCredential(), recovery=devicePairing.recoveryCode(); await client.query("INSERT INTO devices(client_id,device_name,device_id,last_seen,paired_at,status,credential_hash,recovery_code_hash,recovery_code_ciphertext,is_primary) VALUES($1,$2,$3,NOW(),NOW(),'active',$4,$5,$6,FALSE)",[req.session.client.id,pairing.device_name,crypto.randomBytes(16).toString('hex'),devicePairing.hash(credential),devicePairing.hash(recovery),devicePairing.encryptRecovery(recovery)]); await client.query('UPDATE client_pairing_sessions SET client_id=$1,approved_at=NOW(),consumed_at=NOW(),credential_ciphertext=$2 WHERE id=$3',[req.session.client.id,devicePairing.encryptRecovery(credential),pairing.id]); await client.query('COMMIT'); res.redirect('/client?paired=1'); } catch(error){await client.query('ROLLBACK').catch(()=>{});res.status(409).send(error.message);} finally{client.release();}
});

// Active owner scanner.  The camera request is made only from the button click;
// insecure LAN origins immediately expose the short-code path instead.
router.get('/scan', (req, res) => {
  if (!req.session.client || req.session.viewerDevice) return res.redirect('/login');
  const csrf = req.session.csrfToken || '';
  res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить устройство</title>
<style>*{box-sizing:border-box}body{margin:0;padding:16px;background:#111;color:#fff;font:16px Arial}.box{max-width:480px;margin:auto;background:#1b1b1b;padding:20px;border:1px solid #333;border-radius:14px}h2{margin:0 0 10px}video{display:none;width:100%;max-height:55vh;margin-top:12px;background:#000;border-radius:10px}input,button{width:100%;padding:13px;margin-top:10px;border-radius:9px;border:1px solid #444;background:#252525;color:#fff;font-size:16px}button{border:0;background:#356a49;cursor:pointer;pointer-events:auto}.muted{color:#aaa;font-size:14px;line-height:1.4}.fallback{margin-top:16px;padding-top:14px;border-top:1px solid #333}.back{display:block;text-align:center;margin-top:14px;color:#aaa}</style>
<script src="/vendor/jsqr/jsQR.js"></script>
<script>
var milkTvCameraStream=null, milkTvScannerActive=false, milkTvScannerCanvas=null;
var milkTvScannerDiagnostics=[];
function milkTvScanTrace(stage,detail){milkTvScannerDiagnostics.push({at:Date.now(),stage:stage,detail:detail||''});if(milkTvScannerDiagnostics.length>30)milkTvScannerDiagnostics.shift();window.milkTvScannerDiagnostics=milkTvScannerDiagnostics;}
function milkTvCameraMessage(text){var el=document.getElementById('camera-status');if(el)el.textContent=text;}
function milkTvOpenPairingUrl(value){var match=String(value||'').match(new RegExp('/client/pair/approve/([A-Za-z0-9_-]+)(?:[?#].*)?$'));if(!match){milkTvScanTrace('decoded-invalid','unexpected-value');milkTvCameraMessage('QR-код подключения недействителен. Введите код подключения ниже.');return;}milkTvScannerActive=false;milkTvScanTrace('decoded-valid','pairing-url');window.location.href='/client/pair/approve/'+match[1];}
function milkTvJsQrLoop(video){if(!milkTvCameraStream||!milkTvScannerActive)return;if(!window.jsQR){milkTvScanTrace('fallback-missing','jsQR unavailable');return;}if(video.readyState>=2&&video.videoWidth&&video.videoHeight){if(!milkTvScannerCanvas)milkTvScannerCanvas=document.createElement('canvas');milkTvScannerCanvas.width=video.videoWidth;milkTvScannerCanvas.height=video.videoHeight;var context=milkTvScannerCanvas.getContext('2d');context.drawImage(video,0,0,milkTvScannerCanvas.width,milkTvScannerCanvas.height);var image=context.getImageData(0,0,milkTvScannerCanvas.width,milkTvScannerCanvas.height);var result=window.jsQR(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'});if(result&&result.data){milkTvScanTrace('fallback-decoded','qr');milkTvOpenPairingUrl(result.data);return;}}window.setTimeout(function(){milkTvJsQrLoop(video);},180);}
function milkTvScanFrame(video,detector){if(!milkTvCameraStream||!milkTvScannerActive)return;detector.detect(video).then(function(items){if(items&&items[0]&&items[0].rawValue){milkTvScanTrace('barcode-decoded','qr');milkTvOpenPairingUrl(items[0].rawValue);return;}window.setTimeout(function(){milkTvScanFrame(video,detector);},350);},function(error){milkTvScanTrace('barcode-error',error&&error.name?error.name:'error');window.setTimeout(function(){milkTvScanFrame(video,detector);},700);});}
function milkTvStartCamera(){
  var video=document.getElementById('camera-preview');
  if(!window.isSecureContext||!navigator.mediaDevices||typeof navigator.mediaDevices.getUserMedia!=='function'){
    milkTvCameraMessage('Камера недоступна через обычное HTTP-подключение. Введите код подключения ниже.');
    return false;
  }
  milkTvCameraMessage('Запрашиваем доступ к камере…');
  navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}).then(function(stream){
    milkTvCameraStream=stream;milkTvScannerActive=true;video.srcObject=stream;video.style.display='block';milkTvScanTrace('camera-open','stream');
    var playResult=video.play();if(playResult&&typeof playResult.catch==='function')playResult.catch(function(){});
    if(typeof window.BarcodeDetector==='function'){
      milkTvCameraMessage('Камера включена. Наведите её на QR-код.');
      try{milkTvScanTrace('barcode-start','qr_code');milkTvScanFrame(video,new window.BarcodeDetector({formats:['qr_code']}));}catch(_){milkTvScanTrace('barcode-unavailable','constructor');}
    }else{milkTvScanTrace('barcode-unavailable','api');}
    if(typeof window.jsQR==='function'){milkTvScanTrace('fallback-start','jsQR');window.setTimeout(function(){milkTvJsQrLoop(video);},250);}else{milkTvCameraMessage('Камера включена. QR-сканер недоступен, введите код подключения ниже.');}
  },function(error){
    var reason=error&&error.name==='NotAllowedError'?'Доступ к камере запрещён.':'Камера недоступна в этом браузере.';
    milkTvCameraMessage(reason+' Введите код подключения ниже.');
  });
  return false;
}
function milkTvNormalizePairingCode(value){return String(value||'').toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g,'').slice(0,6);}
function milkTvInitPairingCode(){var input=document.getElementById('pair-code'),form=document.getElementById('pair-code-form');if(!input||!form)return;input.addEventListener('input',function(){var normalized=milkTvNormalizePairingCode(input.value);if(input.value!==normalized)input.value=normalized;});input.addEventListener('paste',function(){window.setTimeout(function(){input.value=milkTvNormalizePairingCode(input.value);},0);});form.addEventListener('submit',function(){input.value=milkTvNormalizePairingCode(input.value);});}
function milkTvInitScanner(){
  var button=document.getElementById('open-camera');
  if(!window.isSecureContext||!navigator.mediaDevices||typeof navigator.mediaDevices.getUserMedia!=='function'){
    if(button)button.style.display='none';
    milkTvCameraMessage('Камера недоступна через обычное HTTP-подключение. Введите код подключения ниже.');
  }
}
window.addEventListener('load',function(){milkTvInitScanner();milkTvInitPairingCode();});
window.addEventListener('beforeunload',function(){if(milkTvCameraStream){var tracks=milkTvCameraStream.getTracks();for(var i=0;i<tracks.length;i+=1)tracks[i].stop();}});
</script></head><body><main class="box"><h2>Подключить устройство</h2>
<p id="camera-status" class="muted">Наведите камеру телефона на QR-код на телевизоре.</p>
<button id="open-camera" type="button" onclick="return milkTvStartCamera()">Открыть камеру</button>
<video id="camera-preview" autoplay playsinline muted></video>
<section class="fallback"><strong>Введите код подключения</strong><form id="pair-code-form" method="post" action="/client/pair/code"><input type="hidden" name="_csrf" value="${csrf}"><input id="pair-code" name="code" maxlength="6" minlength="6" pattern="[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}" autocomplete="one-time-code" placeholder="K7M4P2" required><button type="submit">Подключить</button></form></section>
<a class="back" href="/client">Отмена</a></main></body></html>`);
});

// Owner-only scanner for the QR displayed on a TV/PC.  It never creates a
// second pairing session; a decoded URL or short code is sent to the existing approval flow.
// This route intentionally precedes the legacy scanner implementation below.
router.get('/scan-old', (req, res, next) => {
  return res.redirect('/client/scan');
  if (!req.session.client || req.session.viewerDevice) return res.redirect('/login');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключить устройство</title><style>body{margin:0;padding:20px;background:#111;color:#fff;font:18px Arial}.box{max-width:480px;margin:auto;background:#1b1b1b;padding:22px;border-radius:14px}video{width:100%;max-height:55vh;background:#000;border-radius:10px;display:none}input,button{width:100%;box-sizing:border-box;padding:13px;margin-top:10px;border-radius:9px;border:1px solid #444;background:#252525;color:#fff;font-size:16px}button{background:#356a49;border:0;cursor:pointer;pointer-events:auto;opacity:1}.muted{color:#aaa;font-size:14px;line-height:1.4}</style><div class="box"><h2>Подключить устройство</h2><p id="status" class="muted">Наведите камеру телефона на QR-код на телевизоре.</p><video id="camera" autoplay playsinline></video><button id="start" type="button" aria-disabled="false" onclick="if(window.startCamera){window.startCamera();}">Открыть камеру</button><p class="muted">Если камера недоступна, введите код подключения с экрана TV.</p><form method="post" action="/client/pair/code"><input type="hidden" name="_csrf" value="${req.session.csrfToken||''}"><input id="pair-code" name="code" maxlength="6" minlength="6" pattern="[A-Za-z2-9]{6}" placeholder="K7M4P2" autocomplete="one-time-code" required><button type="submit">Подключить</button></form><a href="/client" style="display:block;text-align:center;margin-top:14px;color:#aaa">Отмена</a></div><script>(function(){var video=document.getElementById('camera'),status=document.getElementById('status'),stream=null;function openUrl(value){var m=String(value||'').match(/\/client\/pair\/approve\/([A-Za-z0-9_-]+)(?:[?#].*)?$/);if(!m){status.textContent='QR-код подключения недействителен.';return;}location.href='/client/pair/approve/'+m[1];}window.startCamera=function(){try{if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){status.textContent='Камера недоступна в этом браузере. Введите код подключения ниже.';return;}navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}}).then(function(s){stream=s;video.srcObject=s;video.style.display='block';status.textContent='Камера включена. Наведите её на QR-код.';if('BarcodeDetector' in window){var detector=new BarcodeDetector({formats:['qr_code']});var scan=function(){if(!stream)return;detector.detect(video).then(function(items){if(items&&items[0]&&items[0].rawValue){openUrl(items[0].rawValue);return;}setTimeout(scan,500);}).catch(function(){setTimeout(scan,700);});};scan();}else status.textContent='Сканер QR не поддерживается. Введите код подключения ниже.';}).catch(function(){status.textContent='Камера недоступна в этом браузере. Введите код подключения ниже.';});}catch(_){status.textContent='Камера недоступна в этом браузере. Введите код подключения ниже.';}};window.addEventListener('beforeunload',function(){if(stream)stream.getTracks().forEach(function(t){t.stop();});});}());</script>`);
});

router.get('/scan-legacy', (req, res) => {
  return res.redirect('/client/scan');
  if (!req.session.client || req.session.viewerDevice) return res.redirect('/login');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключить устройство</title><style>body{margin:0;padding:20px;background:#111;color:#fff;font:18px Arial}.box{max-width:480px;margin:auto;background:#1b1b1b;padding:22px;border-radius:14px}video{width:100%;max-height:55vh;background:#000;border-radius:10px;display:none}input,button{width:100%;box-sizing:border-box;padding:13px;margin-top:10px;border-radius:9px;border:1px solid #444;background:#252525;color:#fff;font-size:16px}button{background:#356a49;border:0}.muted{color:#aaa;font-size:14px;line-height:1.4}</style><div class="box"><h2>Подключить устройство</h2><p id="status" class="muted">Наведите камеру телефона на QR-код на телевизоре.</p><video id="camera" autoplay playsinline></video><button id="start">Открыть камеру</button><label class="muted" for="pair-url">Если камера недоступна, вставьте ссылку из QR:</label><input id="pair-url" placeholder="https://.../client/pair/approve/..." autocomplete="off"><button id="open">Открыть подтверждение</button><a href="/client" style="display:block;text-align:center;margin-top:14px;color:#aaa">Отмена</a></div><script>(function(){var video=document.getElementById('camera'),status=document.getElementById('status'),stream=null;function openUrl(value){var m=String(value||'').match(/^(https?:\\/\\/[^\\s]+\\/client\\/pair\\/approve\\/[A-Za-z0-9_-]+)$/);if(!m){status.textContent='Неверная ссылка подключения.';return;}location.href=m[1];}document.getElementById('open').onclick=function(){openUrl(document.getElementById('pair-url').value);};document.getElementById('start').onclick=function(){if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){status.textContent='Камера недоступна на HTTP или в этом браузере. Вставьте ссылку из QR.';return;}navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}}).then(function(s){stream=s;video.srcObject=s;video.style.display='block';status.textContent='Камера включена. Наведите её на QR-код.';if('BarcodeDetector' in window){var detector=new BarcodeDetector({formats:['qr_code']});var scan=function(){if(!stream)return;detector.detect(video).then(function(items){if(items&&items[0]&&items[0].rawValue){openUrl(items[0].rawValue);return;}setTimeout(scan,500);}).catch(function(){setTimeout(scan,700);});};scan();}else status.textContent='Сканер QR не поддерживается. Вставьте ссылку из QR.';}).catch(function(){status.textContent='Камера недоступна. Вставьте ссылку из QR.';});};window.addEventListener('beforeunload',function(){if(stream)stream.getTracks().forEach(function(t){t.stop();});});}());</script>`);
});

router.get('/pair/status/:token', async (req,res) => {
  try {
    const tokenHash=pairingTokenHash(req.params.token);
    const row=(await db.query('SELECT created_at,approved_at,consumed_at,expires_at,credential_ciphertext FROM client_pairing_sessions WHERE token_hash=$1',[tokenHash])).rows[0];
    if(!row){ console.warn('PAIRING_STATUS_NOT_FOUND', {token_hash:tokenHash, server_now:new Date().toISOString()}); return res.status(404).json({status:'NOT_FOUND'}); }
    if(new Date(row.expires_at)<=new Date()){ console.info('PAIRING_EXPIRED', {token_hash:tokenHash,created_at:row.created_at,expires_at:row.expires_at,server_now:new Date().toISOString(),consumed_at:row.consumed_at}); return res.json({status:'EXPIRED',expired:true}); }
    if(row.consumed_at && !row.approved_at) return res.json({status:'CANCELLED',rejected:true});
    if(!row.approved_at) return res.json({status:'WAITING',approved:false});
    return res.json({status:'PAIRED',approved:!!row.credential_ciphertext, completed:!row.credential_ciphertext});
  } catch (_) { return res.status(500).json({status:'ERROR'}); }
});

// Only the waiting TV/browser knows this high-entropy pending-pairing proof.
// The owner approves the session but never receives this device credential.
router.post('/pair/finalize/:token', async (req,res) => {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const pairing=(await client.query('SELECT approved_at,expires_at,credential_ciphertext FROM client_pairing_sessions WHERE token_hash=$1 FOR UPDATE',[pairingTokenHash(req.params.token)])).rows[0];
    if(!pairing) { await client.query('ROLLBACK'); return res.status(404).json({error:'expired'}); }
    if(new Date(pairing.expires_at)<=new Date()) { await client.query('ROLLBACK'); return res.status(410).json({error:'expired'}); }
    if(!pairing.approved_at) { await client.query('ROLLBACK'); return res.status(409).json({error:'pending'}); }
    if(!pairing.credential_ciphertext) { await client.query('ROLLBACK'); return res.status(409).json({error:'completed'}); }
    const credential=devicePairing.decryptRecovery(pairing.credential_ciphertext);
    if(!credential) throw new Error('pairing credential unavailable');
    await client.query('UPDATE client_pairing_sessions SET credential_ciphertext=NULL WHERE token_hash=$1',[pairingTokenHash(req.params.token)]);
    await client.query('COMMIT');
    pairingCookie(res, credential);
    return res.json({ok:true,redirect:'/client/channels'});
  } catch (_) { await client.query('ROLLBACK').catch(()=>{}); return res.status(500).json({error:'unavailable'}); } finally { client.release(); }
});

router.get('/pair/approve/:token', (req,res) => {
  if (!req.session.client || req.session.viewerDevice) return res.redirect('/login?pair='+encodeURIComponent(req.params.token));
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключить устройство</title><style>body{margin:0;padding:20px;background:#111;color:#fff;font:18px Arial}.box{max-width:440px;margin:auto;background:#1b1b1b;padding:22px;border-radius:14px}button{width:100%;padding:14px;margin-top:12px;border:0;border-radius:10px;background:#356a49;color:#fff;font-size:17px}.cancel{background:#333}</style><div class="box"><h2>Подключить устройство?</h2><p>Подтвердите добавление TV к аккаунту.</p><form method="post"><input type="hidden" name="_csrf" value="${req.session.csrfToken||''}"><button>Подключить</button></form><a href="/client" style="display:block;text-align:center;margin-top:12px;color:#aaa">Отмена</a></div>`);
});

router.post('/pair/approve/:token', async (req,res) => {
  if (!req.session.client || req.session.viewerDevice || req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Недействительная сессия');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const pairing=(await client.query('SELECT * FROM client_pairing_sessions WHERE token_hash=$1 FOR UPDATE',[pairingTokenHash(req.params.token)])).rows[0];
    if(!pairing || pairing.consumed_at || new Date(pairing.expires_at)<=new Date()) throw new Error('Код истёк или уже использован');
    const count=Number((await client.query("SELECT COUNT(*)::int AS count FROM devices WHERE client_id=$1 AND status IN ('active','paused')",[req.session.client.id])).rows[0].count);
    if(count>=4) throw new Error('Достигнут лимит устройств');
    const credential=devicePairing.randomCredential(), recovery=devicePairing.recoveryCode();
    const device=(await client.query("INSERT INTO devices(client_id,device_name,device_id,last_seen,paired_at,status,credential_hash,recovery_code_hash,recovery_code_ciphertext,is_primary) VALUES($1,$2,$3,NOW(),NOW(),'active',$4,$5,$6,FALSE) RETURNING id",[req.session.client.id,pairing.device_name,crypto.randomBytes(16).toString('hex'),devicePairing.hash(credential),devicePairing.hash(recovery),devicePairing.encryptRecovery(recovery)])).rows[0];
    await client.query('UPDATE client_pairing_sessions SET client_id=$1,approved_at=NOW(),consumed_at=NOW(),credential_ciphertext=$2 WHERE id=$3',[req.session.client.id,devicePairing.encryptRecovery(credential),pairing.id]);
    await client.query('COMMIT'); res.redirect('/client?paired=1');
  } catch(error){await client.query('ROLLBACK').catch(()=>{});res.status(409).send(error.message);} finally{client.release();}
});

const recoveryAttempts = new Map();
router.get('/recover-device', (req,res) => { if (req.session.viewerDevice) return res.status(403).send('Недоступно для устройства просмотра'); res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Восстановление устройства</title><main style="max-width:420px;margin:20px auto;padding:20px;background:#1b1b1b;color:#fff;border-radius:12px;font:17px Arial"><h2>Восстановление устройства</h2><p style="color:#aaa">Введите код восстановления ранее подключённого устройства.</p><form method="post" action="/client/recover"><input name="code" maxlength="20" placeholder="Код восстановления" required style="width:100%;box-sizing:border-box;padding:12px;margin-top:10px"><button style="width:100%;padding:12px;margin-top:10px">Восстановить</button></form><a href="/client/pair" style="display:block;margin-top:14px;text-align:center;color:#bbb">← Вернуться к подключению</a></main>'); });
router.get('/recover', (req,res) => res.redirect('/client/recover-device'));
router.get('/recover', (req,res) => { if (req.session.viewerDevice) return res.status(403).send('Недоступно для устройства просмотра'); return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Восстановить устройство</title><style>body{margin:0;padding:20px;background:#111;color:#fff;font:17px Arial}.box{max-width:420px;margin:auto;padding:18px;border:1px solid #333;border-radius:12px;background:#1b1b1b}.box input,.box button{width:100%;box-sizing:border-box;padding:12px;margin-top:10px;border-radius:9px;border:1px solid #444;background:#252525;color:#fff;font-size:16px}.box button{background:#356a49;border:0}.back{display:block;margin-top:14px;text-align:center;color:#bbb}</style><main class="box"><h2>Код восстановления</h2><p style="color:#aaa;font-size:14px">Введите код устройства. Оно будет восстановлено без создания нового слота.</p><form method="post"><input id="recovery-code" name="code" maxlength="20" autocomplete="one-time-code" placeholder="K7M4P2" required><button>Восстановить</button></form><a class="back" href="/login">Отмена</a></main><script>(function(){var i=document.getElementById('recovery-code');function n(){i.value=String(i.value||'').replace(/\\s+/g,'').toUpperCase();}i.addEventListener('input',n);i.addEventListener('paste',function(){setTimeout(n,0);});})();</script>`); });
router.post('/recover', async (req,res) => {
  if (req.session.viewerDevice) return res.status(403).send('Недоступно для устройства просмотра');
  const ip=req.ip||'unknown', now=Date.now(), recent=(recoveryAttempts.get(ip)||[]).filter(t=>now-t<15*60*1000);
  if(recent.length>=8)return res.status(429).send('Слишком много попыток. Попробуйте позже.'); recent.push(now); recoveryAttempts.set(ip,recent);
  const code=String(req.body?.code||'').trim().toUpperCase();
  if(!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code) && !/^[A-F0-9]{4}(?:-[A-F0-9]{2,4})+$/.test(code))return res.status(400).send('Неверный формат кода');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query("SELECT d.id,d.client_id,d.status,c.name,c.login,c.active AS client_active,(c.subscription_until IS NULL OR c.subscription_until>LOCALTIMESTAMP) AS subscription_active FROM devices d JOIN clients c ON c.id=d.client_id WHERE d.recovery_code_hash=$1 FOR UPDATE OF d",[devicePairing.hash(code)])).rows[0];
    if(!row){await client.query('ROLLBACK');return res.status(404).send('Код восстановления недействителен.');}
    if(row.status!=='active'){await client.query('ROLLBACK');return res.status(409).send('Устройство заблокировано.');}
    if(!row.client_active||!row.subscription_active){await client.query('ROLLBACK');return res.status(409).send('Клиент заблокирован.');}
    const credential=devicePairing.randomCredential(),nextRecovery=devicePairing.recoveryCode();
    await client.query("UPDATE devices SET credential_hash=$1,recovery_code_hash=$2,recovery_code_ciphertext=$3,playback_generation=playback_generation+1,last_seen=NOW() WHERE id=$4 AND status='active'",[devicePairing.hash(credential),devicePairing.hash(nextRecovery),devicePairing.encryptRecovery(nextRecovery),row.id]);
    await client.query('COMMIT');
    pairingCookie(res,credential);req.session.client={id:row.client_id,name:row.name,login:row.login};req.session.viewerDevice=true;req.session.viewerDeviceId=row.id;
    return req.session.save(error=>{ if(error)return res.status(500).send('Внутренняя ошибка сервера.'); res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Устройство восстановлено</title><main style="max-width:420px;margin:20vh auto;padding:24px;text-align:center;background:#1b1b1b;color:#fff;border-radius:12px;font:18px Arial"><h2>Устройство восстановлено</h2><p>Открываем MILK TV…</p></main><script>setTimeout(function(){location.replace("/client/channels")},700)</script>'); });
  } catch (_) { await client.query('ROLLBACK').catch(()=>{}); res.status(500).send('Восстановление временно недоступно.'); } finally { client.release(); }
});

router.get("/login", async (req, res) => {

  const pair = String(req.query.pair || "").replace(/[^A-Za-z0-9_-]/g, "");
  const pairCode = String(req.query.pair_code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const query = pair ? `?pair=${encodeURIComponent(pair)}` : (pairCode ? `?pair_code=${encodeURIComponent(pairCode)}` : "");
  return res.redirect(302, "/login" + query);

  if (req.session.client) {
    return res.redirect("/client");
  }

  let loginPair = null;
  try { loginPair = await createPairingData(req); } catch (_) {}

  res.send(`
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">

<title>IPTV — Вход</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  background:
    radial-gradient(circle at top, #202020 0%, #111 45%, #090909 100%);

  color: white;

  font-family: Arial, sans-serif;

  padding: 20px;
}

.box {
  width: 100%;
  max-width: 380px;

  background: #1c1c1c;

  border: 1px solid #333;

  border-radius: 18px;

  padding: 30px;

  box-shadow: 0 20px 50px rgba(0,0,0,.45);
}

.logo {
  text-align: center;
  font-size: 42px;
  margin-bottom: 10px;
}

h2 {
  text-align: center;
  margin: 0 0 25px;
}

label {
  display: block;
  margin: 12px 0 6px;
  color: #aaa;
}

input {
  width: 100%;
  padding: 14px;

  border-radius: 10px;
  border: 1px solid #444;

  background: #111;
  color: white;

  font-size: 16px;
}

button {
  width: 100%;

  margin-top: 20px;

  padding: 14px;

  border: none;
  border-radius: 10px;

  background: #333;
  color: white;

  font-size: 16px;
  font-weight: bold;
}

button:hover {
  background: #444;
}

.pair-login { margin-top:22px; padding-top:18px; border-top:1px solid #333; text-align:center; }
.pair-login h3 { margin:0 0 12px; font-size:16px; }
.pair-login p { margin:10px 0 0; color:#aaa; font-size:13px; line-height:1.4; }
.pair-qr { display:block; width:min(72vw,220px); height:auto; margin:0 auto; padding:8px; background:#fff; border-radius:10px; }

button:disabled {
  opacity: .7;
  cursor: wait;
}

</style>

</head>

<body>

<div class="box">

<div class="logo">📺</div>

<h2>IPTV</h2>

<form id="client-login-form" method="POST" action="/login">

${req.query.pair ? `<input type="hidden" name="pair" value="${String(req.query.pair).replace(/[^A-Za-z0-9_-]/g, '')}">` : ''}

<label>Логин</label>

<input
  name="username"
  type="text"
  autocomplete="username"
  required
>

<label>Пароль</label>

<input
  name="password"
  type="password"
  autocomplete="current-password"
  required
>

<button id="client-login-button" type="submit">
Войти
</button>
<a
  href="/client/channels"
  style="
    display:block;
    margin-top:12px;
    padding:14px;
    text-align:center;
    border-radius:10px;
    background:#222;
    color:white;
    text-decoration:none;
    font-size:16px;
    font-weight:bold;
  "
>
Милк Тв❤️
</a>


</form>

<div class="pair-login" aria-label="Подключить телевизор">
  <h3>Подключить телевизор или другое устройство</h3>
  ${loginPair ? `<img src="${loginPair.qr}" alt="QR для подключения" class="pair-qr"><p>Отсканируйте QR на основном устройстве и подтвердите подключение.</p><script>(function(){const t=${JSON.stringify(loginPair.token)};const timer=setInterval(async()=>{try{const r=await fetch('/client/pair/status/'+t);const x=await r.json();if(x.approved){clearInterval(timer);if(x.credential){document.cookie='milktv_device_credential='+encodeURIComponent(x.credential)+'; Max-Age=315360000; Path=/; SameSite=Lax';location.href='/client';}}else if(x.expired){clearInterval(timer);const p=document.querySelector('.pair-login p');if(p)p.textContent='QR истёк. Обновите страницу для нового кода';}}catch(_){}}},3000);})();</script>` : '<p>QR временно недоступен. Обновите страницу.</p>'}
</div>

</div>

<script>

document
  .getElementById("client-login-form")
  .addEventListener("submit", function () {

    const button =
      document.getElementById("client-login-button");

    button.disabled = true;
    button.textContent = "Входим...";

  });

window.addEventListener("pageshow", function () {

  const button =
    document.getElementById("client-login-button");

  button.disabled = false;
  button.textContent = "Войти";

});

</script>

</body>

</html>
  `);

});

router.get("/index.html", (req, res) => {

    res.redirect(req.body?.pair ? "/client/pair/approve/" + encodeURIComponent(String(req.body.pair)) : "/client");

});


router.use(async (req, res, next) => {
  if (req.session.client && req.session.viewerDevice) {
    try {
      const live = (await db.query("SELECT id FROM devices WHERE id=$1 AND status='active' AND credential_hash IS NOT NULL", [req.session.viewerDeviceId])).rows[0];
      if (!live) {
        delete req.session.client;
        delete req.session.viewerDevice;
        delete req.session.viewerDeviceId;
      } else return next();
    } catch (_) { return next(); }
  }
  if (req.session.client) return next();
  const credential = req.headers.cookie?.match(/(?:^|;\s*)milktv_device_credential=([^;]+)/)?.[1];
  if (!credential) return next();
  try {
    const row = (await db.query(`SELECT d.id,d.client_id,c.name,c.login FROM devices d JOIN clients c ON c.id=d.client_id WHERE d.credential_hash=$1 AND d.status='active' AND c.active=TRUE AND (c.subscription_until IS NULL OR c.subscription_until>LOCALTIMESTAMP)`, [devicePairing.hash(decodeURIComponent(credential))])).rows[0];
    if (row) { await db.query("UPDATE devices SET last_seen=NOW() WHERE id=$1", [row.id]); req.session.client={id:row.client_id,name:row.name,login:row.login}; req.session.viewerDevice=true; req.session.viewerDeviceId=row.id; }
  } catch (_) {}
  next();
});


// ===============================
// АВТОРИЗАЦИЯ КЛИЕНТА
// ===============================

router.post("/login", async (req, res) => {

  return res.redirect(307, "/login");

  try {

    const login =
  typeof (req.body.login || req.body.username) === "string"
        ? String(req.body.login || req.body.username).trim()
        : "";

    const password =
      typeof req.body.password === "string"
        ? req.body.password
        : "";

    const result = await db.query(
      `
      SELECT id, name, phone, login, password, active, token
      FROM clients
      WHERE login = $1
      `,
      [login]
    );

    if (result.rows.length === 0) {

      return res.status(401).send("Неверный логин или пароль");

    }

    const client = result.rows[0];
    if (!verifyPassword(password, client.password)) {

      return res.status(401).send("Неверный логин или пароль");

    }

    if (!isPasswordHash(client.password)) {
      await db.query(
        "UPDATE clients SET password = $1 WHERE id = $2",
        [hashPassword(password), client.id]
      );
    }

    if (!client.active) {

      return res.status(403).send("Ваш аккаунт заблокирован");

    }

    req.session.client = {
      id: client.id,
      name: client.name,
      login: client.login
    };
    req.session.viewerDevice = false;

    req.session.save(error => {

      if (error) {
        console.error(
          "CLIENT LOGIN SESSION SAVE ERROR:",
          error.message
        );

        return res.status(500).send(
          "Не удалось создать сессию. Попробуйте войти ещё раз."
        );
      }

      res.redirect("/client");

    });

  } catch (error) {

    console.error("CLIENT LOGIN ERROR:", error.message);

    res.status(500).send(
      "Временная ошибка входа. Попробуйте позже."
    );

  }

});


// ===============================
// ЛИЧНЫЙ КАБИНЕТ
// ===============================

router.get("/", async (req, res) => {

  if (!req.session.client) {

    return res.redirect("/login");

  }

  if (req.session.viewerDevice) {
    return res.redirect("/client/channels");
  }

  try {

    const result = await db.query(
      `
      SELECT
        id,
        name,
        phone,
        login,
        active,
        token,
        google_sub,
        google_email,
        subscription_until,
        TO_CHAR(subscription_until, 'YYYY-MM-DD') AS subscription_until_date,
        (
          subscription_until IS NULL
          OR subscription_until > LOCALTIMESTAMP
        ) AS subscription_active
      FROM clients
      WHERE id = $1
      `,
      [req.session.client.id]
    );

    if (result.rows.length === 0) {

      delete req.session.client;

      return req.session.save(error => {

        if (error) {
          console.error("CLIENT SESSION CLEAR ERROR:", error.message);
          return res.status(500).send("Ошибка сессии");
        }

        res.redirect("/login");

      });

    }

    const client = result.rows[0];
    const devices = (await db.query("SELECT id,device_name,status,paired_at,last_seen,recovery_code_ciphertext FROM devices WHERE client_id=$1 AND status<>'revoked' ORDER BY is_primary DESC,id", [client.id])).rows.map(device => ({ ...device, recovery_code: devicePairing.decryptRecovery(device.recovery_code_ciphertext) }));

    if (!client.active) {

      delete req.session.client;

      return req.session.save(error => {

        if (error) {
          console.error("CLIENT SESSION CLEAR ERROR:", error.message);
          return res.status(500).send("Ошибка сессии");
        }

        res.status(403).send("Ваш аккаунт заблокирован");

      });

    }

    if (!client.subscription_active) {

      delete req.session.client;

      return req.session.save(error => {

        if (error) {
          console.error("CLIENT SESSION CLEAR ERROR:", error.message);
          return res.status(500).send("Ошибка сессии");
        }

        res.status(403).send(`
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Срок доступа истёк</title>
<style>
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:20px; background:#101114; color:#f6f7f9; font-family:Arial,sans-serif; }
.box { width:100%; max-width:420px; padding:24px; border:1px solid #2c3038; border-radius:14px; background:#191b20; text-align:center; }
h1 { margin:0 0 12px; font-size:22px; }
p { margin:0 0 20px; color:#aab1bc; line-height:1.5; }
a { display:block; padding:13px; border-radius:10px; background:#e6eefc; color:#15171c; font-weight:700; text-decoration:none; }
</style>
</head>
<body>
<main class="box">
<h1>Срок доступа истёк</h1>
<p>Персональный кабинет и плейлист временно недоступны. MILK TV остаётся доступным без входа.</p>
<a href="/client/channels">Смотреть MILK TV</a>
</main>
</body>
</html>
        `);

      });

    }

    const playlistUrl = client.token
      ? `${req.protocol}://${req.get("host")}/playlist/${client.token}.m3u`
      : "";

    const escapeHtml = value => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const subscriptionUntil = client.subscription_until_date
      ? client.subscription_until_date.split("-").reverse().join(".")
      : "";

    const phoneHtml = client.phone
      ? `<div class="detail-row"><span>Телефон</span><strong>${escapeHtml(client.phone)}</strong></div>`
      : "";

    const subscriptionHtml = subscriptionUntil
      ? `<div class="detail-row"><span>Доступ до</span><strong>${escapeHtml(subscriptionUntil)}</strong></div>`
      : "";
    const pairingNotice = req.query.paired === "1"
      ? `<div role="status" style="margin:0 0 14px;padding:10px 12px;border:1px solid #31583d;border-radius:9px;background:#183021;color:#b7e4c1">Устройство подключено</div>`
      : "";
    const profileNotice = req.query.profile === "saved" ? "Имя профиля сохранено" : req.query.password === "saved" ? "Пароль изменён" : "";
    const googleIdentityHtml = client.google_sub
      ? `<div class="google-identity"><span><strong>Google</strong><small>${escapeHtml(client.google_email || 'Подключён')}</small></span><b>Подключён</b><form method="post" action="/auth/google/unlink"><input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}"><button class="compact-button copy-button" type="submit">Отключить</button></form></div>`
      : `<div class="google-identity"><span><strong>Google</strong><small>Аккаунт ещё не подключён</small></span><a href="/auth/google/start?returnTo=%2Fclient" class="compact-button copy-button">Подключить</a></div>`;

    res.send(`
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">

<title>Личный кабинет IPTV</title>

<style>

:root{--bg:#0d1422;--panel:#141e2d;--panel-2:#1a2a3d;--border:#2b3d56;--text:#f2f6fb;--muted:#9eabc0;--primary:#3d82e8;--primary-hover:#5c9cf2;--success:#63d69b;--danger:#e26d7a;--shadow:0 14px 36px rgba(0,0,0,.28)}
* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background: #101114;
  color: #f6f7f9;
  font-family: Arial, sans-serif;
}

.container {
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  padding: 20px 16px 32px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin: 4px 0 20px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #8e96a3;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

h1 { margin: 0; font-size: 26px; line-height: 1.15; }

.logout {
  flex: 0 0 auto;
  padding: 10px 12px;
  border: 1px solid #343943;
  border-radius: 10px;
  color: #c7ccd5;
  text-decoration: none;
  font-size: 14px;
}

.card {
  margin-bottom: 12px;
  padding: 18px;
  background: #191b20;
  border: 1px solid #2c3038;
  border-radius: 14px;
}

.card-title { margin: 0 0 14px; font-size: 16px; }
.client-name { margin: 0 0 5px; font-size: 20px; font-weight: 700; }
.client-login { margin: 0; color: #9ca4b1; font-size: 14px; }
.notice { margin:0 0 12px; padding:10px 12px; border:1px solid #31583d; border-radius:9px; background:#183021; color:#b7e4c1; font-size:13px; }

.status {
  display: inline-flex;
  margin-top: 15px;
  padding: 7px 10px;
  border-radius: 999px;
  background: #153526;
  color: #8be3ae;
  font-size: 13px;
  font-weight: 700;
}

.detail-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 0;
  border-top: 1px solid #2c3038;
  color: #9ca4b1;
  font-size: 14px;
}

.detail-row:first-child { border-top: 0; padding-top: 0; }
.detail-row:last-child { padding-bottom: 0; }
.detail-row strong { color: #f6f7f9; font-weight: 600; text-align: right; }

.watch-button,
.copy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
}
.compact-button { width:auto; min-height:38px; margin-top:10px; padding:8px 12px; font-size:13px; }
.inline-form { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
.inline-form input { min-width:0; flex:1 1 180px; }
.inline-form button { flex:0 0 auto; margin-top:0; }
.profile-edit-button { margin-top:12px; }
.form-message { min-height:18px; margin:8px 0 0; color:#ffb8b8; font-size:13px; line-height:1.35; }
.security-summary { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.security-summary-text { min-width:0; }
.password-mask { margin-top:4px; color:#9ca4b1; letter-spacing:3px; font-size:15px; }
.security-form { margin-top:12px; padding-top:12px; border-top:1px solid #2c3038; }
.security-form[hidden], .inline-form[hidden] { display:none; }
.password-field { position:relative; }
.password-field input { padding-right:58px; }
.password-toggle { position:absolute; right:6px; bottom:6px; width:auto; min-height:32px; margin:0; padding:5px 8px; border:1px solid #3b414c; border-radius:7px; background:#252931; color:#dce4f3; font-size:12px; font-weight:600; }
.security-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.security-actions button { flex:1 1 140px; margin:0; }
.google-identity{display:flex;align-items:center;gap:10px;margin-top:14px;padding-top:12px;border-top:1px solid #2c3038}.google-identity span{min-width:0;flex:1}.google-identity strong,.google-identity small{display:block}.google-identity small{margin-top:3px;color:#9eabc0;font-size:12px;overflow:hidden;text-overflow:ellipsis}.google-identity>b{color:#63d69b;font-size:12px;white-space:nowrap}.google-identity form{margin:0}.google-identity button{margin:0}
.security-form label { margin:10px 0 0; }
.security-form label:first-of-type { margin-top:0; }
.security-form input { margin-top:5px; }

.watch-button {
  min-height: 52px;
  margin-bottom: 12px;
  border: 1px solid #e6eefc;
  background: #e6eefc;
  color: #15171c;
}

.playlist-url {
  display: block;
  width: 100%;
  margin: 0 0 10px;
  padding: 12px;
  border: 1px solid #343943;
  border-radius: 10px;
  background: #101114;
  color: #d9e5ff;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
}

.copy-button {
  min-height: 44px;
  border: 1px solid #3b414c;
  background: #252931;
  color: #f6f7f9;
}
.card form[action^="/client/devices/"] { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
.card form[action^="/client/devices/"] .copy-button { width:auto; flex:1 1 130px; min-height:38px; font-size:13px; padding:8px 10px; margin:0; }
.pair-owner { display:inline-flex; margin:0 0 10px; padding:9px 12px; border:1px solid #3b414c; border-radius:10px; color:#f6f7f9; text-decoration:none; font-size:14px; }
.playlist-details { display:none; margin-top:12px; }
.playlist-details.open { display:block; }

.device-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
.device-actions form { flex:1 1 130px; min-width:0; }
.device-actions .copy-button { min-height:38px; font-size:13px; padding:8px 10px; }
.device-name-form { display:flex; gap:8px; margin-top:8px; }
.device-name-form input { min-width:0; flex:1; padding:9px; }
.device-name-form button { width:auto; margin:0; min-height:38px; }
.pair-owner { display:inline-flex; margin:0 0 10px; padding:9px 12px; border:1px solid #3b414c; border-radius:10px; color:#f6f7f9; text-decoration:none; font-size:14px; }
.playlist-details { display:none; margin-top:12px; }
.playlist-details.open { display:block; }

.playlist-message {
  min-height: 18px;
  margin: 9px 0 0;
  color: #9ca4b1;
  font-size: 13px;
}

@media (min-width: 641px) {
  .container { padding-top: 36px; }
}

body{background:radial-gradient(circle at top,#1a2b43 0%,var(--bg) 48%,#080d16 100%);color:var(--text)}
.card{background:var(--panel);border-color:var(--border);box-shadow:var(--shadow)}
.logout,.copy-button,.password-toggle{background:var(--panel-2);border-color:var(--border);color:var(--text)}
.copy-button:hover,.password-toggle:hover{background:var(--primary);border-color:var(--primary-hover)}
.client-login,.eyebrow,.muted{color:var(--muted)}

</style>

</head>

<body>

<div class="container">

${pairingNotice}

${profileNotice ? `<div role="status" class="notice">${profileNotice}</div>` : ""}

<header class="page-header">
  <div>
    <p class="eyebrow">Личный кабинет</p>
    <h1>MILK TV</h1>
  </div>

  <a class="logout" href="/client/logout">Выйти</a>
</header>

<div class="card profile-card">
  <h2 class="card-title">Профиль</h2>
  <p id="profile-name" class="client-name">${escapeHtml(client.name)}</p>
  <p class="client-login">${escapeHtml(client.login)}</p>
  <div class="status">Доступ активен</div>
  <button id="profile-edit" class="copy-button compact-button" type="button">Изменить имя</button>
  <form id="profile-name-form" class="inline-form" method="post" action="/client/profile/name" hidden>
    <input name="name" maxlength="120" value="${escapeHtml(client.name)}" aria-label="Имя профиля" required>
    <input type="hidden" name="_csrf" value="${req.session.csrfToken||''}">
    <button class="copy-button compact-button" type="submit">Сохранить</button><button id="profile-cancel" class="copy-button compact-button" type="button">Отмена</button>
    <div id="profile-message" class="form-message" role="alert" aria-live="polite"></div>
  </form>
</div>

${phoneHtml || subscriptionHtml ? `
<div class="card">
  ${phoneHtml}
  ${subscriptionHtml}
</div>` : ""}

<a class="watch-button" href="/client/channels">Смотреть MILK TV</a>

<div class="card">
<h2 class="card-title">Устройства: ${devices.length} / 4</h2>
<a class="pair-owner" href="/client/scan">Подключить устройство</a>
${devices.map(device => `<div class="device-card" data-device-id="${device.id}" style="padding:12px 0;border-top:1px solid #333"><div class="device-name-row"><b class="device-name" data-device-name>${escapeHtml(device.device_name || 'Устройство')}</b><button type="button" class="copy-button device-edit-name" aria-label="Переименовать устройство">Переименовать</button></div><div style="color:${device.status==='active'?'#79d18a':'#e0aa58'};margin-top:5px">Статус: ${device.status==='active'?'Активно':'Приостановлено'}</div><div style="color:#aaa;font-size:13px;margin-top:4px">Подключено: ${device.paired_at ? new Date(device.paired_at).toLocaleString('ru-RU') : '—'} · Последняя активность: ${device.last_seen ? new Date(device.last_seen).toLocaleString('ru-RU') : '—'}</div>${device.recovery_code ? `<div style="margin-top:5px;font-family:monospace;letter-spacing:2px">Код восстановления: ${escapeHtml(device.recovery_code)}</div>` : ''}<form method="post" action="/client/devices/${device.id}/status"><input type="hidden" name="_csrf" value="${req.session.csrfToken||''}"><button name="action" value="${device.status==='active'?'pause':'resume'}" class="copy-button">${device.status==='active'?'Приостановить':'Возобновить'}</button><button name="action" value="revoke" class="copy-button" style="margin-left:6px">Отключить</button></form></div>`).join('') || '<p class="playlist-message">Устройств нет.</p>'}
</div>

<div class="card security-card">
  <div class="security-summary"><div class="security-summary-text"><h2 class="card-title">Безопасность</h2><div>Пароль кабинета</div><div class="password-mask" aria-label="Пароль скрыт">••••••••</div></div><button id="security-edit" class="copy-button compact-button" type="button">Изменить пароль</button></div>
  ${googleIdentityHtml}
  <form id="security-form" method="post" action="/client/profile/password" class="security-form" hidden>
    <input type="hidden" name="_csrf" value="${req.session.csrfToken||''}">
    <label>Текущий пароль<div class="password-field"><input type="password" name="current_password" autocomplete="current-password" required><button class="password-toggle" type="button" data-target="current_password">Показать</button></div></label>
    <label>Новый пароль<div class="password-field"><input type="password" name="new_password" minlength="8" autocomplete="new-password" required><button class="password-toggle" type="button" data-target="new_password">Показать</button></div></label>
    <label>Повторите новый пароль<div class="password-field"><input type="password" name="confirm_password" minlength="8" autocomplete="new-password" required><button class="password-toggle" type="button" data-target="confirm_password">Показать</button></div></label>
    <div id="security-message" class="form-message" role="alert" aria-live="polite"></div>
    <div class="security-actions"><button id="security-save" class="copy-button" type="submit">Сохранить</button><button id="security-cancel" class="copy-button" type="button">Отмена</button></div>
  </form>
</div>

<div class="card">

<button id="playlist-toggle" class="copy-button" type="button">Мой плейлист</button>
<div id="playlist-details" class="playlist-details">

${playlistUrl ? `
<input
  id="playlist-url"
  class="playlist-url"
  value="${escapeHtml(playlistUrl)}"
  readonly
  onclick="this.select()"
>
<button id="copy-playlist" class="copy-button" type="button">Копировать</button>
<p id="playlist-message" class="playlist-message" aria-live="polite"></p>` : `
<p class="playlist-message">IPTV-ссылка отсутствует.</p>`}

</div>

</div>

</div>

<script>
const copyButton = document.getElementById("copy-playlist");
const playlistInput = document.getElementById("playlist-url");
const playlistMessage = document.getElementById("playlist-message");

if (copyButton && playlistInput) {
  copyButton.addEventListener("click", function () {
    const value = String(playlistInput.value || '');
    function success() { playlistMessage.textContent = "Скопировано"; }
    function fallback() {
      let temp = null, copied = false;
      try {
        temp = document.createElement('textarea'); temp.value = value; temp.setAttribute('readonly','');
        temp.style.position = 'fixed'; temp.style.top = '-1000px'; temp.style.opacity = '0';
        document.body.appendChild(temp); temp.focus(); temp.select();
        copied = !!document.execCommand && document.execCommand('copy');
      } catch (_) { copied = false; }
      if (temp && temp.parentNode) temp.parentNode.removeChild(temp);
      if (copied) success();
      else playlistMessage.textContent = "Не удалось скопировать автоматически. Выделите ссылку и скопируйте её вручную.";
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      Promise.resolve().then(function () { return navigator.clipboard.writeText(value); }).then(success).catch(fallback);
    } else fallback();
  });
}
document.querySelectorAll('form[action^="/client/devices/"][action$="/status"]').forEach((statusForm) => {
  statusForm.querySelectorAll('button[value="revoke"]').forEach((button) => {
    button.textContent = 'Удалить устройство'; button.type = 'button'; button.style.background = '#6b3030'; button.style.borderColor = '#a85a5a';
    button.addEventListener('click', function () {
      const card = statusForm.parentElement, title = card && card.querySelector('b');
      const name = title ? title.textContent : 'это устройство';
      const overlay = document.createElement('div'); overlay.className = 'device-delete-confirm'; overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.62)';
      const dialog = document.createElement('div'); dialog.style.cssText = 'width:min(100%,380px);padding:18px;border:1px solid #555;border-radius:12px;background:#1b1b1b;color:#fff;box-shadow:0 10px 32px rgba(0,0,0,.5)';
      const heading = document.createElement('strong'); heading.textContent = 'Удалить устройство ' + name + '?'; heading.style.display = 'block'; heading.style.fontSize = '17px';
      const note = document.createElement('p'); note.textContent = 'После удаления для повторного подключения потребуется подключить устройство заново.'; note.style.cssText = 'margin:10px 0 16px;color:#bbb;line-height:1.35';
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'copy-button'; cancel.textContent = 'Отмена';
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'copy-button'; confirm.textContent = 'Удалить'; confirm.style.cssText = 'background:#6b3030;border-color:#a85a5a';
      function close(){ document.removeEventListener('keydown', keydown); if(overlay.parentNode)overlay.parentNode.removeChild(overlay); button.focus(); }
      function keydown(event){ if(event.key === 'Escape'){ event.preventDefault(); close(); } }
      cancel.onclick = close;
      overlay.addEventListener('click', function(event){ if(event.target === overlay) close(); });
      confirm.onclick = function(){ const action = document.createElement('input'); action.type = 'hidden'; action.name = 'action'; action.value = 'revoke'; statusForm.appendChild(action); statusForm.submit(); };
      actions.appendChild(cancel); actions.appendChild(confirm); dialog.appendChild(heading); dialog.appendChild(note); dialog.appendChild(actions); overlay.appendChild(dialog); document.body.appendChild(overlay); document.addEventListener('keydown', keydown); cancel.focus();
    });
  });
  const devicePath = String(statusForm.action || '').split('/devices/')[1] || '', id = devicePath.split('/status')[0];
  const card = statusForm.parentElement, title = card && card.querySelector('[data-device-name]');
  if (!id || !card || !title || card.querySelector('.device-rename-form')) return;
  const rename = document.createElement('form'); rename.className = 'device-rename-form'; rename.method = 'post'; rename.action = '/client/devices/' + id + '/name'; rename.style.display = 'inline-flex'; rename.style.gap = '6px'; rename.style.alignItems = 'center'; rename.style.margin = '8px 0';
  const input = document.createElement('input'); input.name = 'device_name'; input.maxLength = 50; input.value = title.textContent || ''; input.setAttribute('aria-label','Имя устройства'); input.style.display = 'none'; input.style.maxWidth = '220px';
  const csrf = statusForm.querySelector('input[name="_csrf"]'); const hidden = document.createElement('input'); hidden.type='hidden'; hidden.name='_csrf'; hidden.value=csrf ? csrf.value : '';
  const edit = card.querySelector('.device-edit-name') || document.createElement('button'); edit.type='button'; edit.className='copy-button'; edit.textContent='Переименовать';
  const save = document.createElement('button'); save.type='submit'; save.className='copy-button'; save.textContent='Сохранить'; save.style.display='none';
  const cancel = document.createElement('button'); cancel.type='button'; cancel.className='copy-button'; cancel.textContent='Отмена'; cancel.style.display='none';
  function close(reset){ if(reset) input.value=title.textContent||''; input.style.display='none'; save.style.display='none'; cancel.style.display='none'; edit.style.display='inline-block'; title.style.display='inline'; }
  edit.onclick=function(){ title.style.display='none'; edit.style.display='none'; input.style.display='inline-block'; save.style.display='inline-block'; cancel.style.display='inline-block'; input.focus(); input.select(); };
  cancel.onclick=function(){ close(true); };
  input.onkeydown=function(event){ if(event.key==='Escape'){event.preventDefault();close(true);} };
  rename.onsubmit=function(event){ input.value=String(input.value||'').replace(/\s+/g,' ').trim(); if(!input.value || input.value.length>50){event.preventDefault();input.focus();return;} };
  rename.appendChild(input); rename.appendChild(hidden); rename.appendChild(edit); rename.appendChild(save); rename.appendChild(cancel); card.insertBefore(rename,statusForm);
});
const playlistToggle = document.getElementById("playlist-toggle");
const playlistDetails = document.getElementById("playlist-details");
if (playlistToggle && playlistDetails) {
  playlistToggle.addEventListener("click", () => { playlistDetails.classList.add("open"); playlistToggle.style.display = "none"; });
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "copy-button"; cancel.textContent = "Отмена";
  cancel.addEventListener("click", () => { playlistDetails.classList.remove("open"); playlistToggle.style.display = "flex"; });
  playlistDetails.appendChild(cancel);
}
const profileEdit=document.getElementById('profile-edit'), profileForm=document.getElementById('profile-name-form'), profileCancel=document.getElementById('profile-cancel');
if(profileEdit&&profileForm){profileEdit.onclick=()=>{profileEdit.hidden=true;profileForm.hidden=false;const input=profileForm.querySelector('input[name=name]');if(input){input.focus();input.select();}};}
if(profileCancel&&profileForm&&profileEdit){profileCancel.onclick=()=>{profileForm.hidden=true;profileEdit.hidden=false;};}
const profileMessage=document.getElementById('profile-message');
if(profileForm){profileForm.onsubmit=async function(event){event.preventDefault();const save=profileForm.querySelector('button[type=submit]'),input=profileForm.querySelector('input[name=name]');const value=String(input&&input.value||'').replace(/\s+/g,' ').trim();if(!value){if(profileMessage)profileMessage.textContent='Введите имя';return;}if(save){save.disabled=true;save.textContent='Сохраняем…';}if(profileMessage)profileMessage.textContent='';try{const response=await fetch(profileForm.action,{method:'POST',headers:{'X-CSRF-Token':profileForm.querySelector('input[name=_csrf]').value,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:profileForm.querySelector('input[name=_csrf]').value,name:value}),redirect:'manual'});if(response.status!==302&&response.status!==303)throw Error(await response.text());const title=document.getElementById('profile-name');if(title)title.textContent=value;profileForm.hidden=true;profileEdit.hidden=false;input.value=value;if(profileMessage)profileMessage.textContent='Имя сохранено';}catch(error){if(profileMessage)profileMessage.textContent=error.message||'Не удалось сохранить имя';}finally{if(save){save.disabled=false;save.textContent='Сохранить';}}};}
const securityEdit=document.getElementById('security-edit'),securityForm=document.getElementById('security-form'),securityCancel=document.getElementById('security-cancel'),securityMessage=document.getElementById('security-message');
if(securityEdit&&securityForm){securityEdit.onclick=()=>{securityEdit.hidden=true;securityForm.hidden=false;const first=securityForm.querySelector('input[name=current_password]');if(first)first.focus();};}
function closeSecurity(){if(!securityForm)return;securityForm.reset();securityForm.hidden=true;if(securityEdit)securityEdit.hidden=false;if(securityMessage)securityMessage.textContent='';securityForm.querySelectorAll('.password-toggle').forEach(button=>{const input=securityForm.querySelector('[name="'+button.dataset.target+'"]');if(input)input.type='password';button.textContent='Показать';});}
if(securityCancel)securityCancel.onclick=closeSecurity;
securityForm&&securityForm.querySelectorAll('.password-toggle').forEach(button=>{button.onclick=()=>{const input=securityForm.querySelector('[name="'+button.dataset.target+'"]');if(!input)return;input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'Показать':'Скрыть';};});
if(securityForm){securityForm.onsubmit=async function(event){event.preventDefault();const save=document.getElementById('security-save'),data=new FormData(securityForm),current=String(data.get('current_password')||''),next=String(data.get('new_password')||''),confirm=String(data.get('confirm_password')||'');if(next.length<8){securityMessage.textContent='Новый пароль должен содержать минимум 8 символов';return;}if(next!==confirm){securityMessage.textContent='Пароли не совпадают';return;}if(save){save.disabled=true;save.textContent='Сохраняем…';}securityMessage.textContent='';try{const csrf=data.get('_csrf'),response=await fetch(securityForm.action,{method:'POST',headers:{'X-CSRF-Token':csrf,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf,current_password:current,new_password:next,confirm_password:confirm}),redirect:'manual'});if(response.status!==302&&response.status!==303)throw Error(await response.text());closeSecurity();const notice=document.createElement('div');notice.className='notice';notice.textContent='Пароль изменён';securityForm.closest('.card').before(notice);setTimeout(()=>notice.remove(),5000);}catch(error){securityMessage.textContent=error.message||'Не удалось изменить пароль';}finally{if(save){save.disabled=false;save.textContent='Сохранить';}}};}
document.querySelectorAll('.device-card').forEach(function(card){if(card.querySelector('code, [style*="monospace"]')){var hint=document.createElement('div');hint.textContent='Используйте этот код для восстановления устройства, если привязка будет потеряна.';hint.style.cssText='margin-top:4px;color:#aaa;font-size:12px;line-height:1.35';card.appendChild(hint);}});
</script>

</body>

</html>
    `);

  } catch (error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});


// ===============================
// ВЫХОД КЛИЕНТА
// ===============================

router.post('/profile/name', async (req,res) => {
  if (!req.session.client || req.session.viewerDevice || req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Недействительная сессия');
  const name=String(req.body?.name||'').replace(/\s+/g,' ').trim();
  if(!name||name.length>120)return res.status(400).send('Некорректное имя');
  try { const q=await db.query('UPDATE clients SET name=$1 WHERE id=$2 RETURNING id,name',[name,req.session.client.id]); if(!q.rows.length)return res.status(404).send('Клиент не найден'); req.session.client.name=name; req.session.save(error=>error?res.status(500).send('Не удалось сохранить профиль'):res.redirect('/client?profile=saved')); } catch (_) { res.status(500).send('Не удалось сохранить профиль'); }
});

router.post('/profile/password', async (req,res) => {
  if (!req.session.client || req.session.viewerDevice || req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Недействительная сессия');
  const current=String(req.body?.current_password||''), next=String(req.body?.new_password||''), confirm=String(req.body?.confirm_password||'');
  if(!current||!next||next.length<8||next!==confirm)return res.status(400).send('Проверьте текущий пароль и подтверждение нового пароля');
  try { const q=await db.query('SELECT password FROM clients WHERE id=$1 AND active=TRUE',[req.session.client.id]); if(!q.rows.length||!verifyPassword(current,q.rows[0].password))return res.status(400).send('Неверный текущий пароль'); await db.query('UPDATE clients SET password=$1 WHERE id=$2',[hashPassword(next),req.session.client.id]); return req.session.save(error=>error?res.status(500).send('Не удалось сохранить пароль'):res.redirect('/client?password=saved')); } catch (_) { res.status(500).send('Не удалось сохранить пароль'); }
});

router.post('/devices/:id/name', async (req,res) => {
  if (!req.session.client || req.session.viewerDevice || req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Недействительная сессия');
  const id=Number(req.params.id), name=String(req.body?.device_name||'').replace(/\s+/g,' ').trim();
  if(!Number.isInteger(id)||!name||name.length>50)return res.status(400).send('Некорректное имя устройства');
  try { const q=await db.query('UPDATE devices SET device_name=$1 WHERE id=$2 AND client_id=$3 AND status<>\'revoked\' RETURNING id',[name,id,req.session.client.id]); if(!q.rows.length)return res.status(404).send('Устройство не найдено'); res.redirect('/client'); } catch (_) { res.status(500).send('Не удалось переименовать устройство'); }
});

router.post('/devices/:id/status', async (req,res) => {
  if (!req.session.client || req.session.viewerDevice || req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Недействительная сессия');
  const id=Number(req.params.id), action=String(req.body?.action||'');
  if(!Number.isInteger(id)||!['pause','resume','revoke'].includes(action))return res.status(400).send('Некорректное действие');
  try {
    const status=action==='pause'?'paused':action==='resume'?'active':'revoked';
    // A password-authenticated owner may revoke any of their devices, including
    // the only/primary one.  The owner web session is deliberately not removed;
    // only the device credential and recovery material are invalidated.
    const q=await db.query("UPDATE devices SET status=$1,playback_generation=playback_generation+CASE WHEN $1 IN ('paused','revoked') THEN 1 ELSE 0 END,is_primary=CASE WHEN $1='revoked' THEN FALSE ELSE is_primary END,credential_hash=CASE WHEN $1='revoked' THEN NULL ELSE credential_hash END,recovery_code_hash=CASE WHEN $1='revoked' THEN NULL ELSE recovery_code_hash END,recovery_code_ciphertext=CASE WHEN $1='revoked' THEN NULL ELSE recovery_code_ciphertext END,last_seen=CASE WHEN $1='revoked' THEN last_seen ELSE NOW() END WHERE id=$2 AND client_id=$3 AND status<>'revoked' RETURNING id",[status,id,req.session.client.id]);
    if(!q.rows.length)return res.status(404).send('Устройство не найдено');
    res.redirect('/client');
  } catch (_) { res.status(500).send('Не удалось изменить статус устройства'); }
});

router.get("/logout", (req, res) => {

  delete req.session.client;

  req.session.save(error => {

    if (error) {
      console.error("CLIENT LOGOUT SESSION SAVE ERROR:", error.message);
      return res.status(500).send("Ошибка выхода");
    }

    res.redirect("/login");

  });

});


// ===============================
// КАНАЛЫ КЛИЕНТА
// ===============================

router.get("/channels", async (req, res) => {
  try {

    const result = await db.query(
      `
      SELECT
        s.original_channel_id AS id,
        current_channel.name,
        current_channel.logo,
        original_channel.milktv_rating,
        original_channel.milktv_manual_boost,
        COALESCE(
          ARRAY_AGG(DISTINCT m.category)
          FILTER (WHERE m.category IS NOT NULL),
          ARRAY[]::text[]
        ) AS milktv_categories
      FROM milktv_channel_slots s
      JOIN channels original_channel
        ON original_channel.id = s.original_channel_id
      JOIN channels current_channel
        ON current_channel.id = s.current_channel_id
      LEFT JOIN milktv_channel_categories m
        ON m.channel_id = s.original_channel_id
      WHERE s.current_channel_id IS NOT NULL
        AND COALESCE(original_channel.visible_to_clients, TRUE) = TRUE
        AND COALESCE(current_channel.milktv_status, '') <> 'quarantine'
        AND NOT EXISTS (
          SELECT 1
          FROM milktv_replacement_pool rp
          WHERE rp.channel_id = s.original_channel_id
            AND rp.enabled = TRUE
        )
      GROUP BY
        s.original_channel_id,
        original_channel.milktv_rating,
        original_channel.milktv_manual_boost,
        s.original_channel_id,
        current_channel.name,
        current_channel.logo
      ORDER BY
        COALESCE(original_channel.milktv_rating,0) DESC,
        current_channel.name ASC
      `
    );

    const categories = [
      "Казахстан",
      "Детские",
      "Кино",
      "Музыка",
      "Спорт"
    ];

    const lowPowerRequested = String(req.query.tvLowPower || '') === '1';
    const channelChunkSize = 48;
    const channelRows = lowPowerRequested ? result.rows.slice(0, channelChunkSize) : result.rows;
    const channelMetadata = result.rows.map(channel => ({ id: channel.id, name: channel.name, logo: channel.logo || '', categories: channel.milktv_categories || [] }));
    const renderChannelCard = channel => `
<div
  class="channel"
  tabindex="0"
  role="button"
  data-id="${channel.id}"
  data-channel-id="${channel.id}"
  data-name="${String(channel.name).replace(/"/g, '&quot;')}"
  data-category="${JSON.stringify(channel.milktv_categories || []).replace(/"/g, '&quot;')}"
  data-logo="${String(channel.logo || "").replace(/"/g, '&quot;')}"
>

${req.session?.client?.id && !req.session?.viewerDevice ? '<button class="channel-favorite" type="button" aria-label="Добавить в избранное">☆</button>' : ''}

<img
  src="${String(channel.logo || "").replace(/"/g, '&quot;')}"
  alt=""
  loading="lazy"
  decoding="async"
  onerror="this.style.visibility='hidden'"
>

<div class="channel-name">
${channel.name}
</div>

</div>
`;
    let channelsHtml = channelRows.map(renderChannelCard).join('');
    const channelMetadataJson = JSON.stringify(channelMetadata).replace(/</g, '\\u003c');

    let html = `
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">

<title>Милк Тв❤️</title><style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #111;
  color: white;
  font-family: Arial, sans-serif;
  padding: 15px;
  padding-left: max(15px, env(safe-area-inset-left));
  padding-right: max(15px, env(safe-area-inset-right));
  padding-bottom: max(15px, env(safe-area-inset-bottom));
  overflow-x: hidden;
}

.login-small {
  display: flex;
  align-items: center;
  justify-content: center;

  width: 100%;
  height: 36px;

  margin-top: 4px;
  margin-bottom: 10px;

  background: linear-gradient(135deg, #333, #1f1f1f);
  border: 1px solid #555;
  border-radius: 9px;

  color: #fff;
  text-decoration: none;

  font-size: 13px;
  font-weight: 600;

  box-shadow: 0 4px 12px rgba(0,0,0,.35);
  transition: .15s;
}

.login-small:hover {
  background: linear-gradient(135deg, #444, #292929);
  border-color: #666;
  transform: translateY(-1px);
}

.login-small:active {
  transform: translateY(1px);
}
.container {
  max-width: 900px;
  margin: auto;
}

h1 {
  text-align: center;
  margin: 5px 0 15px;
}
.milktv-brand {
  color: inherit;
  text-decoration: none;
  display: inline-block;
  cursor: pointer;
}
.main-nav{display:flex;gap:7px;align-items:center;justify-content:center;margin:0 0 10px;flex-wrap:wrap}.main-nav button,.main-nav a{min-height:34px;padding:7px 11px;border:1px solid #444;border-radius:8px;background:#1c1c1c;color:#fff;text-decoration:none;font:600 13px Arial;cursor:pointer}.main-nav .active{border-color:#6c9174;background:#253329}.main-nav button:focus,.main-nav a:focus{outline:2px solid #8ca996;outline-offset:2px;box-shadow:none}

/* ===============================
   ПОИСК
================================ */

.search-box {
  margin-bottom: 12px;
}

.search-box input {
  width: 100%;
  padding: 11px 14px;

  background: #1c1c1c;
  color: white;

  border: 1px solid #333;
  border-radius: 10px;

  outline: none;
  font-size: 14px;
}

.search-box input:focus {
  border-color: #555;
}

/* ===============================
   КАТЕГОРИИ
================================ */

.categories {
  display: flex;
  gap: 7px;

  overflow-x: auto;

  padding-bottom: 10px;
  margin-bottom: 10px;

  scrollbar-width: none;
}

.categories::-webkit-scrollbar {
  display: none;
}

.category {
  flex: 0 0 auto;

  padding: 7px 12px;

  border-radius: 20px;

  background: #1c1c1c;
  border: 1px solid #333;

  color: #aaa;

  font-size: 12px;

  cursor: pointer;

  user-select: none;
}

.category.active {
  background: #333;
  color: white;
  border-color: #555;
}

.player-box {
  display: none;
  position: relative;
}
.player-box:focus { outline: 2px solid #d8c978; outline-offset: 2px; }
/* ===============================
   ПЛЕЕР
================================ */

.player-box {
  display: none;

  background: #000;

  border-radius: 14px;

  overflow: hidden;

  margin-bottom: 20px;
  aspect-ratio: 16 / 9;
  touch-action: pan-x;
}

video {
  width: 100%;

  display: block;

  background: #000;
  height: 100%;
  object-fit: contain;
}


.player-box:fullscreen {
  width: 100%;
  height: 100%;
  margin: 0;
  border-radius: 0;
}

.player-box:fullscreen video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.player-box.mobile-player-fullscreen{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;z-index:2147483000!important;background:#000!important;aspect-ratio:auto!important;overflow:hidden!important;touch-action:none!important}
.player-box.mobile-player-fullscreen video{width:100%!important;height:100%!important;max-height:none!important;object-fit:contain!important}
@supports not (aspect-ratio: 16 / 9) {
  .player-box { height: 0; padding-top: 56.25%; }
  .player-box video { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }
  .player-box:fullscreen { height: 100%; padding-top: 0; }
}

.player-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 4;
  width: min(390px, 88vw);
  padding: 14px 12px 12px;
  overflow: hidden;
  background: rgba(18,20,25,.96);
  border-left: 1px solid rgba(255,255,255,.12);
  box-shadow: -16px 0 40px rgba(0,0,0,.42);
  transform: translateX(102%);
  transition: transform .22s ease;
}

.player-drawer.open {
  transform: translateX(0);
}

.drawer-categories {
  display: flex;
  gap: 7px;
  margin-bottom: 10px;
  overflow-x: auto;
  scrollbar-width: none;
}

.drawer-category {
  flex: 0 0 auto;
  padding: 7px 10px;
  border: 1px solid #3a3e48;
  border-radius: 16px;
  background: #23262e;
  color: #c9ced8;
  font-size: 12px;
  cursor: pointer;
}

.drawer-category.active {
  border-color: #dce6fb;
  background: #dce6fb;
  color: #16181d;
}

.drawer-list {
  height: calc(100% - 38px);
  overflow-y: auto;
  padding-right: 2px;
}

.drawer-channel {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 10px;
  margin-bottom: 7px;
  padding: 9px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: #f2f4f8;
  text-align: left;
  cursor: pointer;
}

.drawer-channel:hover,
.drawer-channel.current {
  border-color: #424957;
  background: #292d36;
}

.drawer-channel img {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  object-fit: contain;
}

.drawer-channel span {
  overflow: hidden;
  font-size: 14px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .player-drawer { width: min(430px, 90vw); }
}

/* ===============================
   ПЛИТКИ
================================ */

.channels {
  display: grid;

  grid-template-columns:
    repeat(auto-fill, minmax(105px, 1fr));

  gap: 10px;
}

.channel {
  position: relative;
  background: #1c1c1c;

  border: 1px solid #333;

  border-radius: 12px;

  padding: 10px 6px;

  text-align: center;

  cursor: pointer;

  transition: .15s;
}

.channel:focus-visible,
.category:focus-visible,
.login-small:focus-visible,
.milktv-brand:focus-visible,
.player-box:focus-visible,
.drawer-channel:focus-visible,
.drawer-category:focus-visible {
  outline: 2px solid #d8c978;
  outline-offset: 2px;
  box-shadow: 0 0 0 1px rgba(216,201,120,.18);
  background: #343b4a;
  color: #fff;
}
.channel:focus,
.category:focus,
.login-small:focus,
.milktv-brand:focus,
.player-box:focus,
.drawer-channel:focus,
.drawer-category:focus { outline: 2px solid #d8c978; outline-offset: 2px; box-shadow: 0 0 0 1px rgba(216,201,120,.18); }

body.tv-low-power * { animation: none !important; transition: none !important; }
body.tv-low-power { background: #111; }
body.tv-low-power .channel,
body.tv-low-power .login-small { box-shadow: none; background: #1b1b1b; }
body.tv-low-power .channel:hover,
body.tv-low-power .login-small:hover { transform: none; }
body.tv-low-power .player-drawer { backdrop-filter: none; box-shadow: none; }
body.tv-low-power .channel img { filter: none; }
.channel img { background: #222; }
.channel { content-visibility: auto; contain-intrinsic-size: 128px 105px; }

.channel:hover {
  background: #252525;

  transform: translateY(-1px);
}

.channel.hidden {
  display: none;
}

.channel img {
  width: 65px;
  height: 65px;

  object-fit: contain;

  display: block;

  margin: auto;

  border-radius: 8px;
}

.channel-name {
  margin-top: 7px;

  font-size: 12px;

  color: #ddd;

  line-height: 1.2;
}

.no-results {
  display: none;

  text-align: center;

  color: #777;

  padding: 30px 10px;
}

/* The card itself owns playback taps; only the favourite button is interactive
   above it.  This prevents image/name layers in mobile WebViews eating taps. */
.channel img,
.channel-name { pointer-events:none; }
.channel-favorite { pointer-events:auto; touch-action:manipulation; }

.channel-favorite { position:absolute; top:5px; right:5px; z-index:3; width:36px; height:36px; border:0; border-radius:50%; background:#0009; color:#fff; font-size:22px; line-height:1; }
.channel-favorite.is-favorite { color:#ffd54a; }

.player-status { display:none; align-items:center; justify-content:space-between; gap:12px; margin-top:8px; padding:10px 12px; border:1px solid #6a3d3d; border-radius:10px; background:#24191b; color:#ffd9d9; font-size:14px; }
.player-status button { flex:0 0 auto; min-height:38px; padding:8px 14px; border:0; border-radius:8px; background:#356a49; color:#fff; cursor:pointer; font-weight:600; }
@media (max-width: 640px) {
  body { padding-top:max(10px, env(safe-area-inset-top)); }
  h1 { font-size:22px; margin:3px 0 9px; }
  .search-box input { min-height:44px; font-size:16px; }
  .category { min-height:38px; padding:9px 13px; }
  .player-box { position:sticky; top:max(6px, env(safe-area-inset-top)); z-index:5; margin-bottom:10px; }
  .channels { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .channel { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:128px; margin:0; padding:9px 6px; text-align:center; touch-action:manipulation; cursor:pointer; }
  .channel img { width:56px; height:56px; margin:0 0 7px; flex:0 0 auto; }
  .channel-name { margin:0; font-size:12px; line-height:1.25; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; text-align:center; }
  .channel-favorite { top:5px; right:5px; width:36px; height:36px; }
  .drawer-channel { min-height:58px; }
}
@media (max-width: 640px) and (orientation: landscape) {
  .page-title,.search-box,.categories,.channels,.back { display:none; }
  .container { max-width:none; }.player-box { position:relative; width:min(100%,calc(100vh * 1.777)); max-height:calc(100vh - 12px); margin:auto; }
}

/* ===============================
   НАЗАД
================================ */

.back {
  display: block;

  margin-top: 20px;

  padding: 12px;

  text-align: center;

  background: #1c1c1c;

  border-radius: 10px;

  color: #aaa;

  text-decoration: none;
}

:root{--milk-bg:#080808;--milk-panel:#171717;--milk-panel-2:#202020;--milk-border:#373737;--milk-gold:#e4be55;--milk-gold-soft:#f2d77b;--milk-muted:#999}
body{background:radial-gradient(circle at 50% 0%,#1a1a1a 0%,var(--milk-bg) 52%);color:#f6f6f6}
.container{max-width:980px;padding:16px 18px 24px}
.client-topbar{display:flex;align-items:center;justify-content:space-between;margin:2px 0 16px;padding:0 4px}.client-topbar h1{flex:1;order:2;margin:0;text-align:center}.client-topbar .device-icon{order:1;color:var(--milk-gold);font-size:34px;text-decoration:none;line-height:1}.profile-icon{order:3;display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--milk-gold);border-radius:50%;color:var(--milk-gold);font-size:22px;text-decoration:none}.milktv-brand{font-weight:700;letter-spacing:-.02em}
.main-nav{display:none}.search-box{position:relative;margin-bottom:14px}.search-box input{height:58px;padding:0 56px 0 48px;background:#171717;border:1px solid #414141;border-radius:30px;color:#f5f5f5;font-size:19px;box-shadow:inset 0 1px 0 #ffffff08}.search-box input::placeholder{color:#8f8f8f}.search-box:before{content:'⌕';position:absolute;z-index:1;left:20px;top:10px;color:#b9b9b9;font-size:32px;pointer-events:none}.search-filter{position:absolute;z-index:2;right:10px;top:9px;width:40px;height:40px;margin:0;padding:0;border:0;background:transparent;color:var(--milk-gold);font-size:28px;cursor:pointer}.categories{gap:8px;margin-bottom:18px;padding:3px 0 8px}.category{padding:10px 18px;background:#171717;border:1px solid #2f2f2f;color:#969696;font-size:15px}.category.active{background:#171717;color:#f5f5f5;border-color:var(--milk-gold);box-shadow:0 0 0 1px #e4be5533}.channels{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.channel{min-height:150px;padding:12px 8px;background:linear-gradient(145deg,#202020,#151515);border:1px solid #343434;border-radius:14px}.channel:hover{background:#252525;border-color:#6c5a2d;transform:translateY(-1px)}.channel img{width:72px;height:72px;background:#111;border-radius:10px}.channel-name{font-size:13px;color:#e4e4e4}.channel-favorite{color:#aaa}.channel-favorite.is-favorite{color:var(--milk-gold)}
@media(max-width:640px){.container{padding:10px 12px 24px}.client-topbar{margin-bottom:13px}.client-topbar h1{font-size:25px}.client-topbar .device-icon{font-size:30px}.profile-icon{width:34px;height:34px;font-size:20px}.search-box input{height:54px;font-size:17px}.categories{overflow-x:auto;flex-wrap:nowrap}.category{padding:10px 17px;min-height:42px}.channels{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.channel{min-height:126px;padding:9px 5px}.channel img{width:54px;height:54px}.channel-name{font-size:11px}}
@media(min-width:1200px){.client-topbar{max-width:760px;margin-left:auto;margin-right:auto}.search-box,.categories{max-width:760px;margin-left:auto;margin-right:auto}.player-box{max-width:760px;margin-left:auto;margin-right:auto}.channels{max-width:980px;margin-left:auto;margin-right:auto}}

/* Preserve the original profile/search/category composition; only recolor it. */
.client-topbar{display:block;margin:0;padding:0}.client-topbar h1{margin:5px 0 15px;text-align:center}.client-topbar .device-icon,.profile-icon{display:none}.main-nav{display:flex;gap:7px;align-items:center;justify-content:center;margin:0 0 10px;flex-wrap:wrap}.main-nav-item{display:flex!important;align-items:center;justify-content:center;min-height:36px;width:100%;padding:7px 11px;border:1px solid #3a3a3a;border-radius:9px;background:#191919;color:#fff;text-decoration:none;font:600 13px Arial;box-shadow:none}.main-nav-item:hover,.main-nav-item.active{border-color:var(--milk-gold);background:#242018;color:#fff}.search-box{position:static;margin-bottom:12px}.search-box:before{display:none}.search-box input{height:auto;padding:11px 14px;background:#171717;border:1px solid #3d3d3d;border-radius:10px;color:#fff;font-size:14px;box-shadow:none}.search-box input:focus{border-color:var(--milk-gold)}.categories{gap:7px;padding-bottom:10px;margin-bottom:10px}.category{padding:7px 12px;border-radius:20px;background:#171717;border:1px solid #353535;color:#bdbdbd;font-size:12px}.category.active{background:#242018;color:#fff;border-color:var(--milk-gold);box-shadow:none}
@media(max-width:640px){.client-topbar h1{font-size:22px;margin:3px 0 9px}.main-nav{justify-content:center}.main-nav-item{width:100%;min-height:36px}.search-box input{min-height:44px;font-size:16px}.categories{overflow-x:auto;flex-wrap:nowrap}.category{min-height:38px;padding:9px 13px}}

/* Compact streaming-style header: brand left, profile action right. */
.page-title{padding-left:2px;padding-right:2px}
.page-title{display:flex;align-items:center;justify-content:flex-start;margin:0;padding:16px 18px 10px}.page-title h1{margin:0;text-align:left;font-size:28px;line-height:1.1}.main-nav{position:absolute;top:16px;right:18px;display:flex;justify-content:flex-end;margin:0;z-index:3}.main-nav-item{width:auto!important;min-height:34px!important;padding:7px 13px 7px 11px!important;border:1px solid #4a4a4a!important;border-radius:999px!important;background:rgba(28,28,28,.88)!important;color:#f1f1f1!important;font-size:13px!important;box-shadow:0 4px 14px #0005!important}.main-nav-item:before{content:'●';display:inline-block;margin-right:7px;color:var(--milk-gold);font-size:12px}.main-nav-item:hover,.main-nav-item.active{border-color:var(--milk-gold)!important;background:#242018!important}
/* Final top bar alignment: keep the brand near the viewport edge and the compact profile pill opposite it. */
.page-title{padding:16px 0 10px!important;margin-left:-8px}.main-nav{right:2px!important}.main-nav-item:before{content:'👤'}
@media(max-width:640px){.page-title{padding:16px 0 10px!important}.main-nav{right:2px!important}}
@media(max-width:640px){.page-title{padding:16px 18px 10px}.page-title h1{font-size:24px}.main-nav{top:16px;right:18px}.main-nav-item{min-height:32px!important;padding:6px 11px!important;font-size:12px!important}.main-nav-item:before{margin-right:5px;font-size:11px}}
/* Keep the complete client screen on one shared content grid at every breakpoint. */
.container{position:relative}
.page-title{margin-left:0!important}
.page-title,.search-box,.categories,.player-box,.channels{max-width:none!important;margin-left:0!important;margin-right:0!important}
.main-nav{right:18px!important}
.main-nav-item{flex-direction:column!important;gap:2px;width:60px!important;height:60px!important;min-height:60px!important;padding:6px 4px!important;border-radius:12px!important}
.main-nav-item:before{margin:0!important;font-size:22px!important;line-height:1}
.main-nav-item:focus-visible{outline:2px solid var(--milk-gold)!important;outline-offset:2px;box-shadow:0 0 0 4px #e4be5540!important}
.page-title h1{font-size:36px!important}
.search-box{margin-top:14px!important}
@media(max-width:640px){.main-nav{right:12px!important}}
@media(max-width:640px){.page-title h1{font-size:30px!important}}

/* Final profile control palette: keep the established 60px layout, soften icon and label. */
.main-nav-item{font-size:11px!important}
.main-nav-item:before{content:'♙'!important;color:#6f737a!important;text-shadow:0 0 0 #fff,0 0 1px #fff!important;font-size:21px!important}

</style>

</head>

<body>

<div class="container">

<div class="page-title">
<h1><a class="milktv-brand" href="/login" aria-label="MILK TV — вход">Милк ТВ❤️</a></h1>
</div>

<nav class="main-nav" aria-label="Основная навигация">
  ${req.session?.viewerDevice ? '' : `<a class="main-nav-item" data-main-nav="profile" href="${req.session?.client?.id ? '/client' : '/login'}">Профиль</a>`}
</nav>

<div class="search-box">

<input
  id="search"
  type="search"
  placeholder="🔎 Найти канал..."
  autocomplete="off"
>

</div>

<div class="categories">

<div
  class="category active"
  tabindex="0"
  role="button"
  data-category="all"
>
Все
</div>
${req.session?.client?.id && !req.session?.viewerDevice ? '<div class="category" tabindex="0" role="button" data-category="favorites">Избранное</div>' : ''}
`;

    categories.forEach(category => {

      html += `
<div
  class="category"
  tabindex="0"
  role="button"
  data-category="${String(category).replace(/"/g, '&quot;')}"
>
${category}
</div>
`;

    });

    html += `

</div>

<div
  id="player-box"
  class="player-box"
  tabindex="0"
  role="region"
  aria-label="Плеер MILK TV"
>

<video
  id="player"
  controls
  playsinline
></video>

<div id="player-status" class="player-status" aria-live="polite"><span id="player-status-text"></span><button id="player-retry" type="button">Повторить</button></div>

<aside
  id="player-drawer"
  class="player-drawer"
  aria-label="Каналы MILK TV"
>
  <div id="drawer-categories" class="drawer-categories"></div>
  <div id="drawer-list" class="drawer-list"></div>
</aside>

</div>

<div class="channels">
${channelsHtml}
</div>
<div
  id="no-results"
  class="no-results"
>
Каналы не найдены
</div>

</div>

<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js"></script>
<script src="/milktv-player-controller.js?v=20260902-turbo-switch"></script>

<script>(function(){var done=false;window.milkTvBootReady=false;window.addEventListener('error',function(event){if(event&&event.target&&event.target!==window)return;if(event&&!event.error&&!event.filename)return;if(done||window.milkTvBootReady)return;setTimeout(function(){if(done||window.milkTvBootReady)return;done=true;var b=document.createElement('div');b.style.cssText='max-width:520px;margin:40px auto;padding:24px;text-align:center;color:#fff;background:#1c1c1c;border:1px solid #444;border-radius:14px;font:18px Arial';b.innerHTML='<strong>MILK TV не удалось запустить в этом браузере.</strong><br><button type="button" style="margin-top:16px;padding:12px 18px;border-radius:9px;border:0">Повторить</button>';b.getElementsByTagName('button')[0].onclick=function(){location.reload();};document.body.innerHTML='';document.body.appendChild(b);},0);});}());</script>
<script>

(function(){var links=document.querySelectorAll('a.login-small[href="/client/login"]');for(var i=0;i<links.length;i+=1)links[i].href='/login';}());

const milkTvLowPowerRequested = ${lowPowerRequested ? 'true' : 'false'};
const milkTvDeviceBound = ${req.session.viewerDevice ? 'true' : 'false'};
const milkTvChannelMetadata = ${channelMetadataJson};
window.milkTvBootReady = false;
window.addEventListener('error', function (event) {
  if (event && event.target && event.target !== window) return;
  if (event && !event.error && !event.filename) return;
  if (window.milkTvBootReady || window.milkTvBootFailureShown) return;
  window.setTimeout(function () {
    if (window.milkTvBootReady || window.milkTvBootFailureShown) return;
    window.milkTvBootFailureShown = true;
    var box = document.createElement('div'); box.style.cssText='max-width:520px;margin:40px auto;padding:24px;text-align:center;color:#fff;background:#1c1c1c;border:1px solid #444;border-radius:14px;font:18px Arial';
    box.innerHTML='<strong>MILK TV не удалось запустить в этом браузере.</strong><br><button type="button" style="margin-top:16px;padding:12px 18px;border-radius:9px;border:0">Повторить</button>';
    box.querySelector('button').onclick=function(){ location.reload(); };
    document.body.innerHTML=''; document.body.appendChild(box);
  }, 0);
});

/* Small, non-telemetric capability probe used to select conservative TV CSS. */
(function () {
  var video = document.createElement('video');
  var ua = String(navigator.userAgent || '');
  var storage = false;
  try { var key = '__milktv_probe__'; window.localStorage.setItem(key, '1'); window.localStorage.removeItem(key); storage = true; } catch (_) {}
  var nativeHls = false;
  try { nativeHls = !!(video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl')); } catch (_) {}
  var caps = {
    userAgent: ua,
    platform: String(navigator.platform || ''),
    viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
    devicePixelRatio: Number(window.devicePixelRatio || 1),
    localStorage: storage,
    cookies: navigator.cookieEnabled !== false,
    mse: !!window.MediaSource,
    nativeHls: nativeHls,
    fullscreen: !!(document.fullscreenEnabled || document.webkitFullscreenEnabled),
    keyboard: true,
    hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
    reducedMotion: false,
    lowPowerLikely: false
  };
  try { caps.reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) {}
  var tvBrowser = /(tizen|webos|smart-tv|smarttv|hbbtv|netcast|googletv|android tv|aft\w+)/i.test(ua);
  var weakCpu = caps.hardwareConcurrency > 0 && caps.hardwareConcurrency <= 2;
  var limitedMedia = !caps.mse && !caps.nativeHls;
  caps.lowPowerLikely = tvBrowser || weakCpu || limitedMedia || caps.reducedMotion;
  var forced = /(?:^|&)tvLowPower=1(?:&|$)/.test(String(location.search || '').replace(/^\\?/, ''));
  if (forced) caps.lowPowerLikely = true;
  window.milkTvCapabilities = caps;
  window.getMilkTvDiagnostics = function () { return { capabilities: caps, startup: window.milkTvStartup || {} }; };
  window.milkTvStartup = { scriptReady: Date.now(), forcedLowPower: forced, initialChannelCards: document.querySelectorAll('.channel').length };
  if (caps.lowPowerLikely) document.body.className += ' tv-low-power';
})();

let selectedCategory = "all";

/* ===============================
   НОРМАЛИЗАЦИЯ ПОИСКА
================================ */

function normalizeText(text) {

  const map = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "i",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sh",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya"
  };

  return String(text)
    .toLowerCase()
    .split("")
    .map(char => map[char] || char)
    .join("")
    .replace(/[^a-z0-9]+/g, "");
}


/* ===============================
   ФИЛЬТРАЦИЯ
================================ */

function filterChannels() {

  const searchValue =
    normalizeText(
      document.getElementById("search").value
    );

  const channels =
    document.querySelectorAll(".channel");

  let visible = 0;

  channels.forEach(channel => {

    const name =
      normalizeText(
        channel.dataset.name || ""
      );

    let channelCategories = [];

    try {
      channelCategories =
        JSON.parse(channel.dataset.category || "[]");
    } catch (error) {
      channelCategories = [];
    }

    const searchMatch =
      !searchValue ||
      name.includes(searchValue);

    const categoryMatch =
      selectedCategory === "all" ||
      (selectedCategory === "favorites" && channel.classList.contains("is-favorite")) ||
      channelCategories.includes(selectedCategory);

    if (searchMatch && categoryMatch) {

      channel.classList.remove("hidden");

      visible++;

    } else {

      channel.classList.add("hidden");

    }

  });

  document.getElementById("no-results").style.display =
    visible === 0
      ? "block"
      : "none";
}


/* ===============================
   ВЫБОР КАТЕГОРИИ
================================ */

function selectCategory(category, element) {

  selectedCategory = category;

  document
    .querySelectorAll(".category")
    .forEach(item => {
      item.classList.remove("active");
    });

  element.classList.add("active");

  filterChannels();
  if (category === 'favorites' && !document.querySelector('.channel.is-favorite')) {
    document.getElementById('no-results').textContent = 'В избранном пока нет каналов';
  } else {
    document.getElementById('no-results').textContent = 'Каналы не найдены';
  }
}

function activateMainNavigation(item) {
  const target = item && item.dataset ? item.dataset.mainNav : '';
  if (!target) return;
  document.querySelectorAll('.main-nav-item').forEach(function (node) { node.classList.toggle('active', node === item); });
  if (target === 'tv') {
    const all = document.querySelector('.category[data-category="all"]');
    if (all) selectCategory('all', all);
    const player = document.getElementById('player-box');
    if (player && player.style.display === 'block') player.focus();
    else document.querySelector('.channel:not(.hidden)')?.focus();
  } else if (target === 'categories') {
    const current = document.querySelector('.category.active') || document.querySelector('.category');
    if (current) current.focus();
  } else if (target === 'favorites') {
    const favorite = document.querySelector('.category[data-category="favorites"]');
    if (favorite) { selectCategory('favorites', favorite); favorite.focus(); }
  }
}

function toggleFavorite(button) {
  const channel = button.closest('.channel');
  if (!channel) return;
  const active = !channel.classList.contains('is-favorite');
  channel.classList.toggle('is-favorite', active);
  button.classList.toggle('is-favorite', active);
  button.textContent = active ? '★' : '☆';
  button.setAttribute('aria-label', active ? 'Убрать из избранного' : 'Добавить в избранное');
  try { localStorage.setItem('milktv.favorite.' + channel.dataset.id, active ? '1' : '0'); } catch (_) {}
  filterChannels();
}
function restoreFavorites() {
  document.querySelectorAll('.channel').forEach(function (channel) {
    try { if (localStorage.getItem('milktv.favorite.' + channel.dataset.id) === '1') { channel.classList.add('is-favorite'); const button = channel.querySelector('.channel-favorite'); if (button) { button.classList.add('is-favorite'); button.textContent = '★'; } } } catch (_) {}
  });
}


/* ===============================
   ПОИСК
================================ */

const clientSearch = document.getElementById("search");
if (clientSearch) {
  clientSearch.addEventListener("input", filterChannels);
}

/*
 * Keep all primary interactions on one delegated path.  In particular, do
 * not make channel playback depend on later optional EPG/player bootstrap:
 * an exception in a non-essential enhancement must never make the grid inert.
 */
let clientInteractionsBound = false;

function bindClientInteractions() {
  if (clientInteractionsBound) return;
  const root = document.querySelector(".container");
  if (!root) {
    return;
  }
  clientInteractionsBound = true;
  root.addEventListener("click", function (event) {
    const target = event.target;
    const favorite = target && target.closest && target.closest(".channel-favorite");
    if (favorite && root.contains(favorite)) {
      event.preventDefault();
      event.stopPropagation();
      toggleFavorite(favorite);
      return;
    }
    const category = target && target.closest && target.closest(".category[data-category]");
    if (category && root.contains(category)) {
      selectCategory(category.dataset.category || "all", category);
      return;
    }
    const mainNav = target && target.closest && target.closest('.main-nav-item[data-main-nav]');
    if (mainNav && root.contains(mainNav) && mainNav.tagName !== 'A') {
      event.preventDefault(); activateMainNavigation(mainNav); return;
    }
    const tile = target && target.closest && target.closest(".channel[data-channel-id]");
    if (tile && root.contains(tile)) {
      const channelId = Number(tile.dataset.channelId);
      if (Number.isInteger(channelId) && channelId > 0) {
        void playLogicalChannel(tile.dataset.name || "", channelId);
      }
    }
  });
  root.addEventListener("focusin", function (event) {
    const tile = event.target && event.target.closest && event.target.closest('.channel[data-channel-id]');
    if (tile) warmPlaybackUrl(tile.dataset.channelId);
  });
  root.addEventListener("pointerover", function (event) {
    const tile = event.target && event.target.closest && event.target.closest('.channel[data-channel-id]');
    if (tile) warmPlaybackUrl(tile.dataset.channelId);
  });
}

bindClientInteractions();


/* ===============================
   ПЛЕЕР
================================ */

let videoPlayer = null;
let currentMilktvChannelId = null;
const milktvClientId = ${
  Number.isInteger(Number(req.session.client?.id))
    ? Number(req.session.client.id)
    : "null"
};
let currentMilktvViewEventId = null;
let playerBox = null;
let playerDrawer = null;
let drawerList = null;
let drawerCategories = null;
let drawerCategory = "all";
let lastPlayback = null;
let playbackRequestId = 0;
let playerController = null;
const playbackUrlCache = new Map();
const playbackTrace = [];

function tracePlayback(stage, detail) {
  const item = { at: new Date().toISOString(), stage: String(stage), detail: String(detail || '') };
  playbackTrace.push(item);
  if (playbackTrace.length > 40) playbackTrace.shift();
  window.milkTvPlaybackTrace = playbackTrace;
}
function cachedPlaybackUrl(channelId) {
  const item = playbackUrlCache.get(String(channelId));
  return item && item.expiresAt > Date.now() ? item.url : '';
}
async function fetchPlaybackUrl(channelId) {
  const key = String(channelId);
  const cached = cachedPlaybackUrl(key);
  if (cached) return cached;
  const existing = playbackUrlCache.get(key);
  if (existing && existing.promise) return existing.promise;
  tracePlayback('token-request', key);
  const playPath = milkTvDeviceBound ? '/api/v1/client/channels/' : '/api/v1/client/public/channels/';
  const promise = fetch(playPath + encodeURIComponent(channelId) + '/play').then(async function (response) {
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.data || !payload.data.playback_url) throw new Error(payload.message || 'Канал временно недоступен');
    const url = payload.data.playback_url;
    playbackUrlCache.set(key, { url: url, expiresAt: Date.now() + 8 * 60 * 1000 });
    tracePlayback('token-ready', key);
    return url;
  }).catch(function (error) {
    playbackUrlCache.delete(key);
    tracePlayback('token-error', error && error.name ? error.name + ':' + error.message : 'request-failed');
    throw error;
  });
  playbackUrlCache.set(key, { promise: promise, expiresAt: 0 });
  return promise;
}
function warmPlaybackUrl(channelId) {
  if (Number(channelId) > 0) fetchPlaybackUrl(channelId).catch(function () {});
}

function playbackTileId(tile) {
  if (!tile || !tile.dataset) return 0;
  return Number(tile.dataset.channelId || tile.dataset.id || 0);
}

function playbackTileVisible(tile) {
  if (!tile || tile.hidden) return false;
  try {
    const style = window.getComputedStyle(tile);
    return style.display !== "none" && style.visibility !== "hidden";
  } catch (_) {
    return true;
  }
}

function warmNeighborPlaybackUrls(channelId) {
  channelId = Number(channelId);
  if (!Number.isInteger(channelId) || channelId <= 0) return;

  const tiles = Array.from(
    document.querySelectorAll(".channels .channel")
  ).filter(playbackTileVisible);

  const index = tiles.findIndex(function (tile) {
    return playbackTileId(tile) === channelId;
  });

  if (index < 0) return;

  [tiles[index - 1], tiles[index + 1]].forEach(function (tile) {
    const id = playbackTileId(tile);
    if (id > 0 && id !== channelId) warmPlaybackUrl(id);
  });
}

function scheduleWarmNeighborPlaybackUrls(channelId) {
  const run = function () {
    warmNeighborPlaybackUrls(channelId);
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 400 });
  } else {
    window.setTimeout(run, 120);
  }
}

let internalPlayerStatus = "";
function setPlayerStatus(text) {
  internalPlayerStatus = String(text || "");
  const el = document.getElementById("player-status");
  if (!el) return;
  const failed = /error|unavailable|failed|blocked|invalid|player-unavailable/i.test(internalPlayerStatus);
  const label = failed ? "Не удалось запустить канал" : "";
  const textEl = document.getElementById("player-status-text");
  if (textEl) textEl.textContent = label;
  el.hidden = !failed;
  el.style.display = failed ? "flex" : "none";
}

let mobilePlayerFullscreenState = null;
function isMobilePlayerViewport() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 900px), (pointer: coarse)').matches);
}
function playerIsFullscreen() { return !!(mobilePlayerFullscreenState || document.fullscreenElement || document.webkitFullscreenElement); }
function enterPlayerFullscreen(box) {
  if (!box) return;
  if (isMobilePlayerViewport()) {
    if (mobilePlayerFullscreenState) return;
    const placeholder = document.createComment('mobile-player-placeholder');
    const scrollY = window.scrollY || window.pageYOffset || 0;
    box.parentNode && box.parentNode.insertBefore(placeholder, box);
    mobilePlayerFullscreenState = { box: box, placeholder: placeholder, scrollY: scrollY, bodyOverflow: document.body.style.overflow };
    box.classList.add('mobile-player-fullscreen');
    document.body.style.overflow = 'hidden';
    closePlayerDrawer();
    return;
  }
  try { if (box.requestFullscreen) { box.requestFullscreen(); return; } if (box.webkitRequestFullscreen) { box.webkitRequestFullscreen(); return; } } catch (_) {}
  var video = document.getElementById('player');
  try { if (video && video.webkitEnterFullscreen) video.webkitEnterFullscreen(); } catch (_) {}
}
function exitPlayerFullscreen() {
  if (mobilePlayerFullscreenState) {
    const state = mobilePlayerFullscreenState;
    const box = state.box;
    box.classList.remove('mobile-player-fullscreen');
    document.body.style.overflow = state.bodyOverflow || '';
    if (state.placeholder && state.placeholder.parentNode) state.placeholder.parentNode.replaceChild(box, state.placeholder);
    mobilePlayerFullscreenState = null;
    window.scrollTo({ top: state.scrollY, left: 0, behavior: 'auto' });
    return;
  }
  try { if (document.exitFullscreen) { document.exitFullscreen(); return; } if (document.webkitExitFullscreen) { document.webkitExitFullscreen(); return; } } catch (_) {}
}

function updateCurrentChannel(name, channelId) {
  const current = document.getElementById("current-channel");

  if (current) {
    current.textContent = name || "Выберите канал";
  }

  document.querySelectorAll(".drawer-channel").forEach(function (item) {
    item.classList.toggle(
      "current",
      String(channelId) === item.dataset.channelId
    );
  });
}

function updateDrawerChannels() {
  if (!drawerList) {
    return;
  }

  const channels = document.querySelectorAll(".channels .channel");

  drawerList.innerHTML = "";

  channels.forEach(function (channel) {
    const name = channel.dataset.name || "";
    let channelCategories = [];

    try {
      channelCategories = JSON.parse(channel.dataset.category || "[]");
    } catch (error) {
      channelCategories = [];
    }

    const matchesCategory = drawerCategory === "all" ||
      channelCategories.includes(drawerCategory);

    if (!matchesCategory) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "drawer-channel";
    button.dataset.channelId = channel.dataset.id || "";

    if (String(currentMilktvChannelId) === button.dataset.channelId) {
      button.classList.add("current");
    }

    const logo = channel.dataset.logo || "";

    if (logo) {
      const image = document.createElement("img");
      image.src = logo;
      image.alt = "";
      image.onerror = function () {
        image.remove();
      };
      button.appendChild(image);
    }

    const label = document.createElement("span");
    label.textContent = name;
    button.appendChild(label);

    button.addEventListener("focus", function () {
      warmPlaybackUrl(button.dataset.channelId);
    });

    button.addEventListener("pointerenter", function () {
      warmPlaybackUrl(button.dataset.channelId);
    });

    button.addEventListener("click", async function () {
      await playLogicalChannel(name, Number(channel.dataset.id));
      closePlayerDrawer();
    });

    drawerList.appendChild(button);
  });
}

function buildDrawerCategories() {
  if (!drawerCategories) {
    return;
  }

  drawerCategories.innerHTML = "";

  const entries = Array.from(
    document.querySelectorAll(".categories .category")
  ).map(function (item) {
    return {
      value: item.dataset.category || "all",
      label: item.textContent.trim()
    };
  });

  entries.forEach(function (entry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drawer-category";
    button.textContent = entry.label;
    button.dataset.category = entry.value;
    button.classList.toggle("active", entry.value === drawerCategory);

    button.addEventListener("click", function () {
      drawerCategory = entry.value;
      drawerCategories.querySelectorAll(".drawer-category").forEach(
        function (item) {
          item.classList.toggle("active", item === button);
        }
      );
      updateDrawerChannels();
    });

    drawerCategories.appendChild(button);
  });
}

function openPlayerDrawer() {
  if (!playerDrawer) {
    return;
  }

  buildDrawerCategories();
  updateDrawerChannels();
  // Opening the drawer after every selection covered the video and made a
  // successful first playback look like a black player.  Keep it closed until
  // the user explicitly opens a navigation surface.
  closePlayerDrawer();
}

function closePlayerDrawer() {
  if (playerDrawer) {
    playerDrawer.classList.remove("open");
  }
}

function setupPlayerUi() {
  playerBox = document.getElementById("player-box");
  playerDrawer = document.getElementById("player-drawer");
  drawerList = document.getElementById("drawer-list");
  drawerCategories = document.getElementById("drawer-categories");

  if (!playerBox) {
    return;
  }

  initVideoPlayer();

  document.addEventListener("fullscreenchange", closePlayerDrawer);
  document.addEventListener("webkitfullscreenchange", closePlayerDrawer);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closePlayerDrawer();
    }
  });

  document.addEventListener("pointerdown", function (event) {
    if (playerDrawer && playerDrawer.classList.contains("open") &&
        !playerDrawer.contains(event.target)) {
      closePlayerDrawer();
    }
  });

}


window.addEventListener("beforeunload", function () {

  if (!currentMilktvChannelId || !currentMilktvViewEventId) {
    return;
  }

  const data = JSON.stringify({
    channel_id: currentMilktvChannelId,
    client_id: milktvClientId,
    event_id: currentMilktvViewEventId
  });

  navigator.sendBeacon(
    "/api/milktv/stop",
    new Blob(
      [data],
      { type: "application/json" }
    )
  );

});

async function stopMilktvView() {

  if (!currentMilktvChannelId || !currentMilktvViewEventId) {
    return;
  }

  const stoppingChannelId = currentMilktvChannelId;
  const stoppingEventId = currentMilktvViewEventId;

  try {

    await fetch("/api/milktv/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        channel_id: stoppingChannelId,
        client_id: milktvClientId,
        event_id: stoppingEventId
      })
    });

  } catch (error) {

    console.error("МИЛК ТВ STOP:", error);

  }

  if (currentMilktvChannelId === stoppingChannelId && currentMilktvViewEventId === stoppingEventId) {
    currentMilktvChannelId = null;
    currentMilktvViewEventId = null;
  }

}


function initVideoPlayer() {

  if (videoPlayer) {
    return videoPlayer;
  }

  videoPlayer = document.getElementById("player");

  if (!videoPlayer) {
    console.error("HTML5-плеер не найден");
    return null;
  }

  videoPlayer.controls = true;
  videoPlayer.preload = "auto";
  videoPlayer.playsInline = true;
  videoPlayer.addEventListener("waiting", function () { setPlayerStatus("loading"); });
  videoPlayer.addEventListener("playing", function () { setPlayerStatus(""); });
  videoPlayer.addEventListener("error", function () { setPlayerStatus("error"); });
  const retry = document.getElementById("player-retry");
  if (retry) retry.addEventListener("click", function () {
    if (!lastPlayback || !lastPlayback.channelId) return;
    void playLogicalChannel(lastPlayback.name || "", lastPlayback.channelId);
  });

  return videoPlayer;
}

function getPlayerController(player) {
  if (playerController) return playerController;
  if (!window.MilkTvPlayerController) return null;
  playerController = window.MilkTvPlayerController.create(player, {
    onLoading: function () { tracePlayback('media-loading', ''); setPlayerStatus("loading"); },
    onPlaying: function () { tracePlayback('media-playing', ''); setPlayerStatus(""); },
    onError: function (error) { tracePlayback('media-error', error && error.name ? error.name + ':' + error.message : String(error || 'unknown')); setPlayerStatus("error"); }
  });
  return playerController;
}

async function playLogicalChannel(name, channelId) {

  const requestId = ++playbackRequestId;
  channelId = Number(channelId);
  if (!Number.isInteger(channelId) || channelId <= 0) {
    setPlayerStatus("invalid-channel");
    return;
  }

  const box = document.getElementById("player-box");

  if (!box) {
    return;
  }
  box.style.display = "block";
  if (document.activeElement !== box) { try { box.focus({ preventScroll: true }); } catch (_) { box.focus(); } }

  const player = initVideoPlayer();

  if (!player) {
    alert("Плеер не найден.");
    return;
  }

  lastPlayback = { url: "", name, channelId };
  setPlayerStatus("loading");
  const search = document.getElementById("search");
  if (search && document.activeElement === search) search.blur();

  let url = cachedPlaybackUrl(channelId);
  const userInitiated = !!url;
  if (!url && !player.currentSrc) {
    // Preserve the originating card gesture on first playback.  Browsers may
    // reject an empty media element, but the rejection is harmless and must
    // not replace the later secure source start.
    try {
      const priming = player.play();
      if (priming && typeof priming.catch === 'function') priming.catch(function () {});
      tracePlayback('gesture-prime', 'first-selection');
    } catch (_) {}
  }
  try {
    if (!url) url = await fetchPlaybackUrl(channelId);
  } catch (error) {
    if (requestId !== playbackRequestId) return;
    tracePlayback('playback-url-failed', error && error.name ? error.name + ':' + error.message : 'unknown');
    setPlayerStatus('playback-unavailable');
    return;
  }
  if (requestId !== playbackRequestId) return;
  lastPlayback = { url, name, channelId };
  if (currentMilktvChannelId) void stopMilktvView();
  currentMilktvChannelId = channelId;
  currentMilktvViewEventId = null;
  updateCurrentChannel(name, channelId);
  if (requestId !== playbackRequestId) return;
  const controller = getPlayerController(player);
  if (!controller) {
    setPlayerStatus("player-unavailable");
    return;
  }
  tracePlayback('controller-play', userInitiated ? 'prepared-user-gesture' : 'token-after-gesture');
  controller.play(url, { userInitiated: userInitiated });

  // Prepare the previous and next channel only after current playback has
  // already started. This fetches only secure playback URLs, not video data.
  scheduleWarmNeighborPlaybackUrls(channelId);

  // Viewing statistics must never postpone actual media start.  The prior
  // awaited start/stop requests pushed video.play() outside the card gesture.
  void fetch("/api/milktv/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel_id: channelId, client_id: milktvClientId })
  }).then(function (response) {
    if (!response.ok) throw new Error('view-start');
    return response.json();
  }).then(function (data) {
    if (currentMilktvChannelId === channelId && data && data.event && data.event.id) currentMilktvViewEventId = data.event.id;
  }).catch(function (error) { tracePlayback('view-start-error', error && error.message ? error.message : 'failed'); });

  if (!playerIsFullscreen()) {
    box.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }

}
/* ===============================
   ПОЛНОЭКРАННЫЙ ПЛЕЕР + МЕНЮ
================================ */

setupPlayerUi();
restoreFavorites();

/* In low-power mode keep the initial DOM small and append ordered chunks. */
(function setupLowPowerChunks() {
  if (!milkTvLowPowerRequested) return;
  var grid = document.querySelector('.channels');
  if (!grid || !milkTvChannelMetadata || milkTvChannelMetadata.length <= grid.querySelectorAll('.channel').length) return;
  var nextIndex = grid.querySelectorAll('.channel').length;
  var size = 48;
  function appendChunk() {
    if (nextIndex >= milkTvChannelMetadata.length) return false;
    var fragment = document.createDocumentFragment();
    var end = Math.min(nextIndex + size, milkTvChannelMetadata.length);
    for (; nextIndex < end; nextIndex += 1) {
      var item = milkTvChannelMetadata[nextIndex], card = document.createElement('div');
      card.className = 'channel'; card.tabIndex = 0; card.setAttribute('role','button'); card.dataset.id = item.id; card.dataset.channelId = item.id; card.dataset.name = item.name || ''; card.dataset.category = JSON.stringify(item.categories || []); card.dataset.logo = item.logo || '';
      if (${req.session?.client?.id ? 'true' : 'false'}) { var star=document.createElement('button'); star.className='channel-favorite'; star.type='button'; star.setAttribute('aria-label','Добавить в избранное'); star.textContent='☆'; card.appendChild(star); }
      if (item.logo) { var img=document.createElement('img'); img.src=item.logo; img.alt=''; img.loading='lazy'; img.decoding='async'; img.onerror=function(){this.style.visibility='hidden';}; card.appendChild(img); }
      var label=document.createElement('div'); label.className='channel-name'; label.textContent=item.name || ''; card.appendChild(label); fragment.appendChild(card);
    }
    grid.appendChild(fragment); restoreFavorites(); filterChannels(); return true;
  }
  window.milkTvAppendNextChunk = appendChunk;
  grid.addEventListener('focusin', function(event){ var cards=grid.querySelectorAll('.channel'); var index=Array.prototype.indexOf.call(cards,event.target.closest('.channel')); if(index >= cards.length - 8) appendChunk(); });
  window.addEventListener('scroll', function(){ if(window.innerHeight + window.pageYOffset >= document.body.offsetHeight - 500) appendChunk(); });
})();

/* Conservative delegated D-pad navigation for TV browsers and keyboards. */
(function setupTvFocusNavigation() {
  const grid = document.querySelector('.channels');
  if (!grid) return;
  let lastFocused = null;
  function visibleChannels() { return Array.from(grid.querySelectorAll('.channel:not(.hidden)')); }
  function channelById(id) { return visibleChannels().find(item => String(item.dataset.id) === String(id)) || null; }
  function focusChannel(channel) {
    if (!channel) return;
    if (window.milkTvAppendNextChunk) {
      var cards = grid.querySelectorAll('.channel');
      var position = Array.prototype.indexOf.call(cards, channel);
      if (position >= cards.length - 8) window.milkTvAppendNextChunk();
    }
    if (!window.milkTvStartup.firstFocusableAt) window.milkTvStartup.firstFocusableAt = Date.now();
    lastFocused = channel.dataset.id || null;
    try { localStorage.setItem('milktv.focus.channel', lastFocused); localStorage.setItem('milktv.focus.scroll', String(window.scrollY || 0)); } catch (_) {}
    channel.focus({ preventScroll: true });
    channel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function firstVisible() { return visibleChannels()[0] || null; }
  function topLogin() { return document.querySelector('.main-nav-item[data-main-nav="profile"]') || document.querySelector('.milktv-brand, .login-small'); }
  function mainNavItems() { return Array.from(document.querySelectorAll('.main-nav-item')); }
  function topSearch() { return document.getElementById('search'); }
  function activeCategory() { return document.querySelector('.category.active') || document.querySelector('.category'); }
  function focusPlayerBox() { const box=document.getElementById('player-box'); if(box&&box.style.display==='block'){box.focus();return true;} return false; }
  function moveChannel(current, key) {
    const items = visibleChannels(); if (!items.length) return null;
    const from = current && current.matches('.channel:not(.hidden)') ? current : firstVisible();
    if (!from) return null;
    const r = from.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const candidates = items.filter(item => item !== from).map(item => { const q=item.getBoundingClientRect(); return {item, x:q.left+q.width/2, y:q.top+q.height/2}; }).filter(q => (key==='ArrowLeft'&&q.x<cx)||(key==='ArrowRight'&&q.x>cx)||(key==='ArrowUp'&&q.y<cy)||(key==='ArrowDown'&&q.y>cy));
    candidates.sort((a,b) => { const da=Math.hypot(a.x-cx,a.y-cy), db=Math.hypot(b.x-cx,b.y-cy); const pa=(key==='ArrowLeft'||key==='ArrowRight')?Math.abs(a.y-cy):Math.abs(a.x-cx), pb=(key==='ArrowLeft'||key==='ArrowRight')?Math.abs(b.y-cy):Math.abs(b.x-cx); return (pa-pb)*3 + da-db; });
    return candidates[0]?.item || from;
  }
  function restoreFocus() {
    let target = null;
    try { const id=localStorage.getItem('milktv.focus.channel'); target=id ? channelById(id) : null; } catch (_) {}
    target = target && !target.classList.contains('hidden') ? target : firstVisible();
    if (target) focusChannel(target);
    try { const y=Number(localStorage.getItem('milktv.focus.scroll')); if (Number.isFinite(y) && y>0) window.scrollTo(0,y); } catch (_) {}
  }
  window.addEventListener('beforeunload', () => { try { localStorage.setItem('milktv.focus.scroll', String(window.scrollY || 0)); } catch (_) {} });
  window.addEventListener('load', () => { if (document.activeElement === document.body) restoreFocus(); });
  document.addEventListener('click', event => { const tile=event.target.closest && event.target.closest('.channel'); if (tile) { lastFocused=tile.dataset.id || null; try { localStorage.setItem('milktv.focus.channel',lastFocused); } catch (_) {} } });
  document.addEventListener('keydown', event => {
    const target=event.target, tag=String(target?.tagName||'').toLowerCase();
    if (tag==='input' || tag==='textarea' || tag==='select') {
      if (target && target.id==='search' && event.key==='ArrowDown') { event.preventDefault(); const category=activeCategory(); if(category)category.focus(); return; }
      if (target && target.id==='search' && event.key==='ArrowUp') { event.preventDefault(); const login=topLogin(); if(login)login.focus(); else focusPlayerBox(); return; }
      return;
    }
    if (tag==='video' && event.key!=='Escape' && event.key!=='Backspace') return;
    const player = document.getElementById('player'), box = document.getElementById('player-box');
    if ((event.key==='Escape' || event.key==='Backspace') && playerIsFullscreen()) { event.preventDefault(); exitPlayerFullscreen(); if(box)box.focus(); return; }
    if (target === box && (event.key === 'Enter' || event.keyCode === 13)) { event.preventDefault(); if(player&&player.paused){const result=player.play();if(result&&typeof result.catch==='function')result.catch(function(){setPlayerStatus('play-blocked');});}else enterPlayerFullscreen(box); return; }
    if (target === box && event.key === 'ArrowUp') { event.preventDefault(); const category=activeCategory(); if(category)category.focus(); else { const search=topSearch(); if(search)search.focus(); } return; }
    if (target === box && event.key === 'ArrowLeft') { event.preventDefault(); const category=activeCategory(); if(category)category.focus(); return; }
    if (target === box && event.key === 'ArrowRight') { event.preventDefault(); focusChannel((lastFocused&&channelById(lastFocused))||firstVisible()); return; }
    if (target === box && event.key === 'ArrowDown') { event.preventDefault(); focusChannel((lastFocused&&channelById(lastFocused))||firstVisible()); return; }
    const drawer=document.getElementById('player-drawer');
    if (drawer && drawer.classList.contains('open')) {
      const drawerItems=Array.from(drawer.querySelectorAll('.drawer-channel,.drawer-category')); const idx=drawerItems.indexOf(target.closest('.drawer-channel,.drawer-category'));
      if (event.key==='Escape' || event.key==='Backspace') { event.preventDefault(); closePlayerDrawer(); if(lastFocused) focusChannel(channelById(lastFocused)); return; }
      if (event.key==='ArrowDown'||event.key==='ArrowRight') { event.preventDefault(); (drawerItems[idx<0?0:Math.min(idx+1,drawerItems.length-1)]||drawerItems[0])?.focus(); return; }
      if (event.key==='ArrowUp'||event.key==='ArrowLeft') { event.preventDefault(); (drawerItems[idx<0?0:Math.max(idx-1,0)]||drawerItems[0])?.focus(); return; }
      if (event.key==='Enter' && target.closest('.drawer-channel,.drawer-category')) { event.preventDefault(); target.closest('.drawer-channel,.drawer-category').click(); return; }
    }
    if (event.key==='Escape' || event.key==='Backspace') {
      const box=document.getElementById('player-box');
      if (box && box.style.display==='block') { event.preventDefault(); box.style.display='none'; const targetCard=lastFocused&&channelById(lastFocused); if(targetCard) focusChannel(targetCard); return; }
    }
    const login=target.closest && target.closest('.login-small, .milktv-brand');
    if (login && event.key==='ArrowDown') { event.preventDefault(); const search=topSearch(); if(search)search.focus(); else { const category=activeCategory(); if(category)category.focus(); } return; }
    const nav=target.closest && target.closest('.main-nav-item');
    if (nav && (event.key==='ArrowLeft'||event.key==='ArrowRight')) { event.preventDefault(); const items=mainNavItems(),i=items.indexOf(nav),next=items[i+(event.key==='ArrowRight'?1:-1)]||nav; next.focus(); return; }
    if (nav && event.key==='ArrowDown') { event.preventDefault(); if(nav.dataset.mainNav==='categories'||nav.dataset.mainNav==='favorites'){activateMainNavigation(nav);return;} const search=topSearch(); if(search)search.focus(); else if(!focusPlayerBox())focusChannel(firstVisible()); return; }
    if (nav && event.key==='ArrowUp') { event.preventDefault(); const brand=document.querySelector('.milktv-brand'); if(brand)brand.focus(); return; }
    if (nav && event.key==='Enter' && nav.tagName!=='A') { event.preventDefault(); activateMainNavigation(nav); return; }
    const category=target.closest && target.closest('.category');
    if (category && (event.key==='ArrowLeft'||event.key==='ArrowRight')) { event.preventDefault(); const cats=Array.from(document.querySelectorAll('.category')); const i=cats.indexOf(category); (cats[i+(event.key==='ArrowRight'?1:-1)]||category).focus(); return; }
    if (category && event.key==='ArrowUp') { event.preventDefault(); const search=topSearch(); if(search)search.focus(); else { const login=topLogin(); if(login)login.focus(); } return; }
    if (category && event.key==='ArrowDown') { event.preventDefault(); if(!focusPlayerBox())focusChannel(firstVisible()); return; }
    if (category && event.key==='Enter') { event.preventDefault(); category.click(); focusChannel(firstVisible()); return; }
    const channel=target.closest && target.closest('.channel');
    if (channel && /^Arrow/.test(event.key)) { event.preventDefault(); const next=moveChannel(channel,event.key); if (event.key==='ArrowUp' && next===channel) { if(box&&box.style.display==='block')box.focus();else document.querySelector('.category.active')?.focus(); } else focusChannel(next); return; }
    if (channel && event.key==='Enter') { event.preventDefault(); channel.click(); return; }
    if (target===document.body && /^Arrow/.test(event.key)) { event.preventDefault(); focusChannel(moveChannel(null,event.key)); }
  });
  setTimeout(restoreFocus, 0);
})();
window.milkTvBootReady = true;


</script>

</body>

</html>

`;

    // Keep every user-facing login entry on the canonical root renderer.
    html = html.replace(/href="\/client\/login"/g, 'href="/login"');

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);
  } catch (error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});

module.exports = router;
