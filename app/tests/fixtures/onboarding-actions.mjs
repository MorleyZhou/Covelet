import assert from 'node:assert/strict';
export default async ({ evaluate, send, delay, on, writeFile, extId, output }) => {
  const requests = [], objects = new Map(); let authFailure = false, failWrites = false;
  on('Fetch.requestPaused', async ({requestId,request,networkId}) => {
    let responseCode = 503, body = '', contentType = 'text/plain';
    if (request.url.startsWith('https://www.bing.com/covelet-setup-fixture/')) {
      requests.push({method:request.method,url:request.url});
      const url = new URL(request.url);
      if (authFailure) { responseCode=401; body='PRIVATE-RESPONSE-MUST-NOT-LEAK'; }
      else if (request.method === 'PROPFIND') {
        responseCode=207; contentType='application/xml';
        const item = (href, length) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${length===undefined?'<d:collection/>':''}</d:resourcetype>${length===undefined?'':`<d:getcontentlength>${length}</d:getcontentlength>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${item(url.href)}${Object.entries(request.headers).some(([key,value])=>key.toLowerCase()==='depth'&&value==='1')?[...objects].filter(([href])=>href.startsWith(url.href)&&!href.slice(url.href.length).includes('/')).map(([href, bytes])=>item(href,bytes.length)).join(''):''}</d:multistatus>`;
      } else if (request.method === 'MKCOL') responseCode=201;
      else if (request.method === 'GET') { responseCode=objects.has(url.href)?200:404; body=objects.get(url.href)||''; contentType='application/json'; }
      else if (request.method === 'PUT') {
        if(failWrites) responseCode=403;
        else { responseCode=201; let payload=request.postData; if(payload===undefined) payload=(await send('Network.getRequestPostData',{requestId:networkId})).postData; objects.set(url.href,Buffer.from(payload)); }
      }
    }
    await send('Fetch.fulfillRequest',{requestId,responseCode,responseHeaders:[{name:'Content-Type',value:contentType}],body:Buffer.from(body).toString('base64')});
  });
  await send('Fetch.enable',{patterns:[{urlPattern:'http://*'},{urlPattern:'https://*'}]});
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"chrome.i18n.getUILanguage = () => 'zh-CN';"});
  await send('Page.navigate',{url:`chrome-extension://${extId}/newtab.html`});
  const wait = async (expression, label, timeout=15000) => { for(let elapsed=0;elapsed<timeout;elapsed+=100){if(await evaluate(expression))return;await delay(100);}throw Error('Timed out: '+label+'\n'+await evaluate('document.body.innerText')); };
  const click = async text => { await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)}); if (!b || b.disabled) throw Error('Missing/disabled button '+${JSON.stringify(text)}); b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0})); b.click(); })()`); await delay(150); };
  const fill = async (label,value) => { await evaluate(`(() => {const el=[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(label)})?.querySelector('input'); if (!el) throw Error('Missing input '+${JSON.stringify(label)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(50); };
  const text = () => evaluate('document.body.innerText');
  const has = value => `document.body.innerText.includes(${JSON.stringify(value)})`;
  const screenshot = async name => {const data=await send('Page.captureScreenshot',{format:'png'});await writeFile(`${output}/${name}.png`,Buffer.from(data.data,'base64'));};
  const openSettings = async () => {await wait('!!document.querySelector("button[title=设置]")','settings launcher');await evaluate('document.querySelector("button[title=设置]").click()');await delay(200);};
  const openSync = async () => {await openSettings();await click('数据');await click('自定义存储同步');await wait('!!document.querySelector(".cloud-sync-form")','sync form');await delay(200);};
  const nextDisabled = () => evaluate('[...document.querySelectorAll("button")].find(b=>b.innerText.trim()==="下一步").disabled');
  const credentials = async () => {await fill('WebDAV 基目录地址','https://www.bing.com/covelet-setup-fixture/');await fill('WebDAV 用户名','FIXTURE-USER');await fill('WebDAV 应用密码','FIXTURE-APP-PASSWORD');};
  await openSettings();await click('隐私自查');await wait(has('当前权限与用途'),'privacy page');
  assert.match(await text(),/未记录网络请求历史/);assert.match(await text(),/Bing 每日壁纸/);assert.match(await text(),/chrome.storage.session/);
  assert.match(await text(),/storage/);assert.match(await text(),/notifications/);assert.match(await text(),/未授予/);assert.match(await text(),/https:\/\/www.bing.com\/\*/);
  assert.doesNotMatch(await text(),/近 7 天[^\n]*[:：]\s*0/);
  assert.equal(requests.length,0,'checkup performs no sync requests');await screenshot('privacy-desktop');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await delay(150);
  assert.equal(await evaluate('document.querySelector(".settings-content").scrollWidth<=document.querySelector(".settings-content").clientWidth+1'),true,'privacy fits narrow screen');await screenshot('privacy-narrow');
  await send('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
  await click('数据');await click('自定义存储同步');await wait(has('选择渠道'),'step one');
  assert.equal(await evaluate('document.querySelector(".cloud-channel-option[aria-pressed=true]").innerText.includes("WebDAV")'),true);
  assert.equal(await evaluate('document.querySelectorAll(".cloud-channel-option").length'),5);await screenshot('step-one');
  await click('仅在本机使用');assert.equal(await evaluate('!!document.querySelector(".cloud-sync-form")'),false);
  assert.equal(await evaluate('new Promise(r=>chrome.storage.session.get("covelet.cloud.session.v1",v=>r(!!v["covelet.cloud.session.v1"])))'),false);
  await openSync();
  for(const [provider,required,absent] of [['Cloudflare R2（Beta）','Bucket 名称','WebDAV 用户名'],['阿里云 OSS（Beta）','地域','仓库所有者'],['GitHub（Beta）','仓库名称','WebDAV 基目录地址'],['GitLab（Beta）','项目 ID 或完整路径','Bucket 名称']]) {
    await click(provider);await click('下一步');assert.match(await text(),new RegExp(required));assert.doesNotMatch(await text(),new RegExp(absent));assert.equal(await evaluate('!!document.querySelector("input[autocomplete=new-password]")'),false);await click('上一步');
  }
  await click('WebDAV\n推荐');await click('下一步');
  assert.equal(await nextDisabled(),true);await fill('WebDAV 基目录地址','http://invalid.example/');await click('测试连接');assert.match(await text(),/WebDAV 地址无效/);assert.equal(requests.length,0);
  await credentials();authFailure=true;await click('测试连接');await wait(has('WebDAV 登录失败（401）'),'401 inline');assert.equal(await nextDisabled(),true);assert.doesNotMatch(await text(),/PRIVATE-RESPONSE-MUST-NOT-LEAK/);
  authFailure=false;await click('测试连接');await wait(has('最近连接测试通过'),'test passes');assert.equal(await nextDisabled(),false);assert.equal(await evaluate('!!document.querySelector("input[autocomplete=new-password]")'),false);
  await fill('WebDAV 应用密码','FIXTURE-APP-PASSWORD-CHANGED');assert.equal(await nextDisabled(),true);assert.match(await text(),/连接尚未验证/);
  await click('测试连接');await wait(has('最近连接测试通过'),'retest passes');await screenshot('step-two');await click('下一步');
  await fill('同步密码','short');const beforePassword=requests.length;await click('保存并首次同步');assert.match(await text(),/至少需要 12 个字符/);assert.equal(requests.length,beforePassword);
  await fill('同步密码','FIXTURE-SYNC-PASSWORD');await evaluate('document.querySelector("button[role=switch]").click()');failWrites=true;
  await click('保存并首次同步');await wait(has('WebDAV 拒绝访问（403）'),'write failure visible',30000);
  assert.equal(await evaluate('document.querySelector(".cloud-setup-steps [aria-current=step]").innerText.includes("密码与首次同步")'),true,'failed sync does not complete setup');await screenshot('step-three-failed');
  assert.equal(await evaluate('document.querySelector(".cloud-setup-error").getBoundingClientRect().bottom <= document.querySelector(".cloud-sync-actions").getBoundingClientRect().top + 1'),true,'failure stays visible above actions');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await delay(100);
  assert.equal(await evaluate('document.querySelector(".cloud-sync-form").scrollWidth <= document.querySelector(".cloud-sync-form").clientWidth + 1'),true,'setup fits narrow screen');await screenshot('step-three-failed-narrow');
  await send('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
  const beforeFallback=requests.length;await click('仅在本机使用');await wait('!document.querySelector(".cloud-sync-form")','local fallback closes');
  assert.equal(await evaluate('new Promise(r=>chrome.storage.session.get("covelet.cloud.session.v1",v=>r(!!v["covelet.cloud.session.v1"])))'),false);await delay(300);assert.equal(requests.length,beforeFallback,'fallback issues no cloud requests');
  await openSync();assert.match(await text(),/需解锁/);assert.doesNotMatch(await text(),/自动同步已开启/);assert.doesNotMatch(await text(),/最近连接测试通过/);
  await click('修改配置');await click('下一步');await credentials();await evaluate('document.querySelector(".cloud-sync-form").requestSubmit()');assert.equal(await nextDisabled(),true);assert.doesNotMatch(await text(),/至少需要 12 个字符/,'unverified step 2 submission cannot fall through to unlock');await click('测试连接');await wait(has('最近连接测试通过'),'retry connection');await click('下一步');await fill('同步密码','FIXTURE-SYNC-PASSWORD');await evaluate('document.querySelector("button[role=switch]").click()');failWrites=false;
  await click('保存并首次同步');await wait('!document.querySelector(".cloud-setup-steps")','first sync success',45000);await wait(has('最近同步：'),'successful sync timestamp');assert.ok(objects.size>0);assert.match(await text(),/自动同步已开启/);await screenshot('first-sync-complete');
  for(const bytes of objects.values()){assert.equal(bytes.includes('FIXTURE-SYNC-PASSWORD'),false);assert.equal(bytes.includes('FIXTURE-APP-PASSWORD'),false);}
  await click('修改配置');await click('下一步');await credentials();await click('测试连接');await wait(has('最近连接测试通过'),'save-only connection');await click('下一步');await fill('同步密码','FIXTURE-SYNC-PASSWORD');const beforeSave=requests.length;await click('保存配置');await wait('!document.querySelector(".cloud-setup-steps")','save only returns to management');assert.equal(requests.length,beforeSave,'save-only performs no WebDAV request');assert.doesNotMatch(await text(),/自动同步已开启/);
  await click('锁定');await wait(has('当前凭据的连接尚未验证'),'locking clears proof');assert.doesNotMatch(await text(),/最近连接测试通过/);
  await fill('WebDAV 用户名','FIXTURE-USER');await fill('WebDAV 应用密码','FIXTURE-APP-PASSWORD');await fill('同步密码','FIXTURE-SYNC-PASSWORD');const beforeUnlock=requests.length;await click('解锁');await wait(has('已解锁'),'unlock without verification');assert.equal(requests.length,beforeUnlock);assert.match(await text(),/当前凭据的连接尚未验证/);
  await writeFile(`${output}/results.json`,JSON.stringify({passed:true,fixtureObjects:objects.size,requests,checks:['runtime permissions and honest seven-day disclosure','privacy narrow layout','WebDAV default and four selectable Beta channels','local escape before setup','provider-specific fields','HTTPS and Chinese 401 errors','test without password and credential proof invalidation','password validation','failed first PUT stays in step 3','local fallback clears session and auto-sync','retry succeeds with encrypted writes','save-only performs zero requests','lock invalidates verification']},null,2));
}
