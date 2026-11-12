const {chromium,devices}=require('playwright');
const OUT=process.argv[2];
const BASE='http://localhost:8765';
const user={id:'11111111-1111-1111-1111-111111111111',aud:'authenticated',role:'authenticated',email:'sam@example.com',created_at:'2025-03-01T00:00:00Z',user_metadata:{username:'sam',privacy_version:'2026-10-28'},app_metadata:{}};
const sess={access_token:'h.'+Buffer.from(JSON.stringify({sub:user.id,exp:4e9})).toString('base64url')+'.s',token_type:'bearer',expires_in:3600,expires_at:4e9,refresh_token:'r',user};
async function ctxFor(b,signed,survey){
  const ctx=await b.newContext({viewport:{width:390,height:797},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:devices['iPhone 13'].userAgent});
  await ctx.route('https://fbgfylfnbtxzbwgilktt.supabase.co/**',async r=>{const u=r.request().url();
    if(u.includes('/auth/v1/user'))return r.fulfill({json:user});
    if(u.includes('/rest/v1/profiles'))return r.fulfill({json:[{id:user.id,username:'sam',display_name:'Sam'}]});
    return r.fulfill({json:[]});});
  await ctx.addInitScript(([s,sv,signed])=>{try{document.addEventListener('DOMContentLoaded',()=>{const st=document.createElement('style');st.textContent='.story-taphint{display:none!important}.story-disc{box-shadow:none!important}';document.head.appendChild(st);});localStorage.setItem('co2_seen_intro','true');if(sv)localStorage.setItem('ecoimpact_survey',sv);if(signed)localStorage.setItem('sb-fbgfylfnbtxzbwgilktt-auth-token',s);}catch(e){}},[JSON.stringify(sess),survey,signed]);
  return ctx;
}
(async()=>{
  const b=await chromium.launch();
  // A realistic finished survey: the typical UK resident's answers.
  const c0=await b.newContext();const p0=await c0.newPage();await p0.goto(BASE+'/');await p0.waitForTimeout(800);
  const survey=await p0.evaluate(()=>JSON.stringify({...window.ECO_DATA.UK_TYPICAL_SURVEY,banking:{amount:5000,bank:'barclays',pensionPot:0,pensionProvider:''},completedAt:'2026-11-01T10:00:00Z'}));await c0.close();
  const shot=async(p,name)=>{await p.waitForTimeout(700);await p.screenshot({path:OUT+'/'+name+'.png'});console.log('shot',name);};
  // 1. Welcome, fresh visitor
  let ctx=await b.newContext({viewport:{width:390,height:797},deviceScaleFactor:3,isMobile:true,hasTouch:true});
  await ctx.route('https://fbgfylfnbtxzbwgilktt.supabase.co/**',r=>r.fulfill({json:[]}));
  await ctx.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{const st=document.createElement('style');st.textContent='.story-disc{box-shadow:none!important}';document.head.appendChild(st);}));let p=await ctx.newPage();await p.goto(BASE+'/#/');await p.waitForTimeout(2200);await shot(p,'welcome');
  const y=await p.evaluate(()=>{const t=document.querySelector('.wl-track');const top=t.getBoundingClientRect().top+scrollY;const h=t.offsetHeight-document.querySelector('.wl-stage').offsetHeight;return [0.62,0.97].map(f=>Math.round(top+f*h));});
  await p.evaluate(v=>scrollTo(0,v),y[0]);await p.waitForTimeout(1200);await shot(p,'welcome-cats');
  await p.evaluate(v=>scrollTo(0,v),y[1]);await p.waitForTimeout(1200);await shot(p,'welcome-budget');
  await ctx.close();
  // 2. Survey, meals week
  ctx=await ctxFor(b,false,null);p=await ctx.newPage();await p.goto(BASE+'/#/');await p.waitForTimeout(1500);
  await p.click('[data-action=set-diet][data-key=meat_eater]');await p.waitForTimeout(900);
  for(const [k,n] of [['veggie',2],['chicken',3],['fish',1],['beef',1]])for(let i=0;i<n;i++){await p.click('[data-action=meal-count][data-key='+k+'][data-delta="1"]');await p.waitForTimeout(60);}
  await p.evaluate(()=>{const q=document.querySelector('.q-list');scrollTo(0,q.getBoundingClientRect().top+scrollY-120);});await p.waitForTimeout(500);await shot(p,'survey');await ctx.close();
  // 3. Results, signed in
  ctx=await ctxFor(b,true,survey);p=await ctx.newPage();await p.goto(BASE+'/#/results');await p.waitForTimeout(6500);await shot(p,'results');
  await p.evaluate(()=>{const e=document.querySelector('.res-chart, .res-grid');if(e)scrollTo(0,e.getBoundingClientRect().top+scrollY-80);});await p.waitForTimeout(2200);await shot(p,'results-2');
  // 4. Picture your year story
  await p.evaluate(()=>{scrollTo(0,0);const b=document.querySelector('[data-action=pi-story]');b&&b.click();});await p.waitForTimeout(1500);
  const sc=await p.evaluate(()=>{const s=document.querySelector('.story-scroll');const t=document.querySelector('.story-track');const w=document.querySelector('.warm-track');return {t:t.offsetTop,th:t.offsetHeight,w:w?w.offsetTop:0,wh:w?w.offsetHeight:0,vh:s.clientHeight};});
  const sTo=async(v)=>{await p.evaluate(v=>{document.querySelector('.story-scroll').scrollTop=v;},v);await p.waitForTimeout(1300);};
  await sTo(sc.t+(sc.th-sc.vh)*0.7);await shot(p,'story');
  await sTo(sc.w+(sc.wh-sc.vh)*0.97);await shot(p,'warm');
  await ctx.close();
  // 5. Habits
  ctx=await ctxFor(b,true,survey);p=await ctx.newPage();await p.goto(BASE+'/#/habits');await p.waitForTimeout(3500);await shot(p,'levelup');await p.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(b=>/Keep going/.test(b.textContent));b&&b.click();});await p.waitForTimeout(2500);await shot(p,'habits');await ctx.close();
  // 6. Greener switches
  ctx=await ctxFor(b,false,null);p=await ctx.newPage();await p.goto(BASE+'/greener-switches/');await p.waitForTimeout(3000);await shot(p,'switches');
  await p.evaluate(()=>{const f=document.querySelector('.sw-feat');scrollTo(0,f.getBoundingClientRect().top+scrollY-70);});await p.waitForTimeout(2600);await shot(p,'switches-act');
  await ctx.close();await b.close();
})();
