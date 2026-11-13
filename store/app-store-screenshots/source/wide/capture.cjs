// Captures the seven screens at iPad (1032 x 1352 pt) or laptop (1440 x 860) size, at 2x.
const {chromium}=require('playwright');const MODE=process.argv[2],OUT=process.argv[3];const BASE='http://localhost:8765';
const VP=MODE==='ipad'?{width:1032,height:1352}:{width:1440,height:860};
const user={id:'11111111-1111-1111-1111-111111111111',aud:'authenticated',role:'authenticated',email:'sam@example.com',created_at:'2025-03-01T00:00:00Z',user_metadata:{username:'sam',privacy_version:'2026-10-28'},app_metadata:{}};
const sess={access_token:'h.'+Buffer.from(JSON.stringify({sub:user.id,exp:4e9})).toString('base64url')+'.s',token_type:'bearer',expires_in:3600,expires_at:4e9,refresh_token:'r',user};
const HIDE='.story-taphint{display:none!important}.story-disc{box-shadow:none!important}';
async function ctxFor(b,signed,survey){
 const ctx=await b.newContext({viewport:VP,deviceScaleFactor:2,isMobile:MODE==='ipad',hasTouch:MODE==='ipad'});
 await ctx.route('https://fbgfylfnbtxzbwgilktt.supabase.co/**',async r=>{const u=r.request().url();
  if(!signed)return r.fulfill({status:401,json:{}});
  if(u.includes('/auth/v1/user'))return r.fulfill({json:user});
  if(u.includes('/rest/v1/profiles'))return r.fulfill({json:[{id:user.id,username:'sam',display_name:'Sam'}]});
  return r.fulfill({json:[]});});
 await ctx.addInitScript(([s,sv,signed,css])=>{try{document.addEventListener('DOMContentLoaded',()=>{const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);});localStorage.setItem('co2_seen_intro','true');localStorage.setItem('co2_hb_level:11111111-1111-1111-1111-111111111111','9');localStorage.setItem('co2_hb_won:11111111-1111-1111-1111-111111111111','[1,2,3,4,5,6,7]');if(sv)localStorage.setItem('ecoimpact_survey',sv);if(signed)localStorage.setItem('sb-fbgfylfnbtxzbwgilktt-auth-token',s);}catch(e){}},[JSON.stringify(sess),survey,signed,HIDE]);
 return ctx;}
(async()=>{const b=await chromium.launch();
 const c0=await b.newContext();const p0=await c0.newPage();await p0.goto(BASE+'/');await p0.waitForTimeout(800);
 const survey=await p0.evaluate(()=>JSON.stringify({...window.ECO_DATA.UK_TYPICAL_SURVEY,banking:{amount:5000,bank:'barclays',pensionPot:0,pensionProvider:''},completedAt:'2026-11-01T10:00:00Z'}));await c0.close();
 const shot=async(p,n)=>{await p.waitForTimeout(800);await p.screenshot({path:OUT+'/'+n+'.png'});console.log('shot',n);};
 // 1 welcome story at the pie
 let ctx=await ctxFor(b,false,null);let p=await ctx.newPage();await p.goto(BASE+'/#/');await p.waitForTimeout(2000);
 await p.evaluate(()=>localStorage.removeItem('co2_seen_intro'));await p.goto(BASE+'/#/welcome');await p.waitForTimeout(2000);
 const y=await p.evaluate(()=>{const t=document.querySelector('.wl-track');const top=t.getBoundingClientRect().top+scrollY;const h=t.offsetHeight-document.querySelector('.wl-stage').offsetHeight;return Math.round(top+(2.5/4)*h);});
 await p.evaluate(v=>scrollTo(0,v),y);await p.waitForTimeout(1300);await shot(p,'welcome');await ctx.close();
 // 2 survey meals
 ctx=await ctxFor(b,true,null);p=await ctx.newPage();await p.goto(BASE+'/#/');await p.waitForTimeout(1800);
 await p.click('[data-action=set-diet][data-key=meat_eater]');await p.waitForTimeout(900);
 for(const [k,n] of [['veggie',2],['chicken',3],['fish',1],['beef',1]])for(let i=0;i<n;i++){await p.click('[data-action=meal-count][data-key='+k+'][data-delta="1"]');await p.waitForTimeout(60);}
 await p.mouse.move(0,0);await p.evaluate(()=>scrollTo(0,0));await shot(p,'survey');await ctx.close();
 // 3 results, 4 story, 7 warming
 ctx=await ctxFor(b,true,survey);p=await ctx.newPage();await p.goto(BASE+'/#/results');await p.waitForTimeout(6000);await shot(p,'results');
 await p.evaluate(()=>{const b=document.querySelector('[data-action=pi-story]');b&&b.click();});await p.waitForTimeout(1500);
 const sc=await p.evaluate(()=>{const s=document.querySelector('.story-scroll');const t=document.querySelector('.story-track');const w=document.querySelector('.warm-track');return {t:t.offsetTop,th:t.offsetHeight,w:w?w.offsetTop:0,wh:w?w.offsetHeight:0,vh:s.clientHeight};});
 const sTo=async(v)=>{await p.evaluate(v=>{document.querySelector('.story-scroll').scrollTop=v;},v);await p.waitForTimeout(1400);};
 await sTo(sc.t+(sc.th-sc.vh)*0.7);await shot(p,'story');
 await sTo(sc.w+(sc.wh-sc.vh)*0.97);await shot(p,'warm');await ctx.close();
 // 5 greener switches act 1
 ctx=await ctxFor(b,false,null);p=await ctx.newPage();await p.goto(BASE+'/greener-switches/');await p.waitForTimeout(3000);
 await p.evaluate(()=>{const f=document.querySelector('.sw-feat');scrollTo(0,f.getBoundingClientRect().top+scrollY-90);});await p.waitForTimeout(2800);await shot(p,'switches');await ctx.close();
 // 6 habits
 ctx=await ctxFor(b,true,survey);p=await ctx.newPage();await p.goto(BASE+'/#/habits');await p.waitForTimeout(3500);await shot(p,'habits');await ctx.close();
 // extra: how we calculate card
 ctx=await ctxFor(b,false,null);p=await ctx.newPage();await p.goto(BASE+'/how-we-calculate/');await p.waitForTimeout(3000);
 await p.evaluate(()=>{const c=document.querySelector('.calc');scrollTo(0,c.getBoundingClientRect().top+scrollY-100);});await p.waitForTimeout(400);await p.click('[data-action=calc-ex][data-key=bank]');await p.waitForTimeout(2600);await shot(p,'calc');await ctx.close();
 await b.close();})();
