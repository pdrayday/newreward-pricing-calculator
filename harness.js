#!/usr/bin/env node
/* ============================================================================
   NewReward pricing calculator — regression harness (build NR-20260916-71)

   independent(): a from-the-spec reimplementation of the Google+Meta ads math
   (adCAC / budgetAuto / adFee / adCust / phased taper). It deliberately does
   NOT read the calculator source — it mirrors ADS-FEATURE-SPEC.md, so a bug
   in either implementation shows up as a mismatch.

   Usage:
     node harness.js            # pure edge tests (no browser needed)
     node harness.js --live     # + cross-check the real calculator via Playwright
                                #   (expects index.html next to this file, or pass
                                #    a path: node harness.js --live path/to/calc.html)
   ========================================================================= */
'use strict';

/* ---------- the independent spec mirror ---------- */
function independent(q, acqPct, budgetIn){
  // q: {cpcEff, closeRate (fraction), yearlyValue, capStretch, newCust, vol,
  //     capApplied, nScopes, rampMonth, rampSpan, contractStyle}
  const feePct = b => b>15000 ? 0.12 : 0.15;
  const fee = b => b>0 ? Math.max(500, Math.round(b*feePct(b)/50)*50) : 0;
  /* CHANNEL-FIT LAW (Sept 28): paid clicks convert at the vertical's paidconv factor; a customer may
     cost the LARGER of the stated acquisition budget and the payback rule (retained 2+ yrs → a year
     of gross profit at the keep-rate; one-time → half the gross profit). Tested against the ALL-IN
     cost per customer (media + management), only while capacity remains (Sept 17 hardening). */
  const paidConv=q.paidconv??1;
  const cpc=q.cpcEff||0, close=q.closeRate*paidConv;
  const adCAC=(cpc>0&&close>0)? cpc/close : null;                 // media-only CAC
  const keepR=Math.max(5,(q.margin||0)-(q.commission||0))/100;
  const gpYear=q.yearlyValue*keepR;
  const acqStated=(acqPct!=null?acqPct:15)/100*q.yearlyValue;     // what the client says a customer may cost
  const paybackAllow=gpYear*((q.retainYears||1)>=2?1.0:0.5);
  const acqAllowed=Math.max(acqStated,paybackAllow);
  const organicOn=q.nScopes>0;
  const roomAtPace=Math.max(0,q.capStretch-(organicOn?q.newCust:0));
  const noRoom=organicOn&&roomAtPace<=1e-9;
  const clickCeil=0.5*q.vol*cpc;                                  // never buy more than half the market's clicks
  let budgetCandidate=0;
  if(adCAC!=null&&roomAtPace>0){
    let b=Math.max(500,roomAtPace*adCAC);                          // fill remaining capacity; $500 soft floor
    b=Math.min(b, clickCeil);                                      // hard ceiling
    b=Math.round(b/250)*250;                                       // $250 snap
    if(b>clickCeil) b-=250;                                        // snap never breaches the ceiling
    budgetCandidate=Math.max(0,b);
  }
  const testedBudget=budgetIn!=null?Math.max(0,budgetIn):budgetCandidate;
  const testedWins=(cpc>0&&testedBudget>0)?Math.min(testedBudget/cpc*close,organicOn?roomAtPace:q.capStretch):0;
  const allInCAC=testedWins>0?(testedBudget+fee(testedBudget))/testedWins:null;
  const adsViable=!noRoom&&allInCAC!=null&&allInCAC<=acqAllowed;
  const veryEfficient=adsViable&&allInCAC<=0.5*acqAllowed;
  const cacEff=allInCAC!=null?allInCAC:adCAC;
  const paybackMo=(cacEff!=null&&gpYear>0)? cacEff/(gpYear/12) : null;
  const ltvCac=(cacEff!=null&&cacEff>0)? gpYear*Math.max(1,q.retainYears||1)/cacEff : null;
  const budgetAuto=adsViable?budgetCandidate:0;
  const budget=budgetIn!=null?testedBudget:budgetAuto;
  const adFull=(cpc>0&&budget>0)? Math.min(budget/cpc*close, organicOn?roomAtPace:q.capStretch) : 0;   // floor-style model
  const roiAds=(budget+fee(budget))>0 ? adFull*q.yearlyValue/(budget+fee(budget)) : null;
  const rm=q.rampMonth, span=q.rampSpan||3, rampFull=rm+span-1;
  const fW=m=> m===1?0:Math.min(1,(m-1)/(rm+span-2));
  const demandLimited=!q.capApplied;
  const scaleMode=veryEfficient&&demandLimited;                    // headroom + efficiency: hold, don't taper
  const floorB=budget>0? (demandLimited?0:Math.max(500,Math.round(budget*0.30/250)*250)) : 0;
  const taperStart=(organicOn&&budget>0&&q.newCust>0&&!scaleMode&&rampFull+1<=12)? rampFull+1 : null;
  /* CLOSING LAG (spec update, Aug 17): the customers won in month m come from the clicks
     bought in month m − lag. Fast purchases: 0. $10k+: 1. Contract-style or $25k+: 2. */
  const lagM=Math.max((q.contractStyle||q.yearlyValue>=25000)?2:(q.yearlyValue>=10000?1:0),
                      q.industry==='b2b'?1:0);   // B2B never closes same-month from a cold click
  const bSched=[];
  for(let m=1;m<=12;m++){
    let bm=budget;
    if(taperStart!=null&&m>=taperStart){
      const k=Math.min(1,(m-taperStart+1)/3);
      bm=budget-(budget-floorB)*k;
      bm=Math.max(floorB, Math.round(bm/250)*250);
    }
    bSched.push(bm);
  }
  const months=[]; let adsWinsYr=0, adsCostYr=0;
  for(let m=1;m<=12;m++){
    const bm=bSched[m-1];
    const bWin=(m-lagM>=1)? bSched[m-1-lagM] : 0;
    const org=organicOn? q.newCust*fW(m):0;
    const bEff=Math.min(bWin, clickCeil);          // wins from at most half-the-market's clicks
    const adm=(cpc>0&&bEff>0)? Math.min(bEff/cpc*close, Math.max(0,q.capStretch-org)) : 0;
    months.push({m, budget:bm, fee:fee(bm), ads:adm, organic:org, total:org+adm});
    adsWinsYr+=adm; adsCostYr+=bm+fee(bm);
  }
  /* INTEGER win schedules (spec update, Aug 14): cumulative rounding — each month prints
     the whole customers landed by then; every month an integer, the year adds up exactly. */
  let cumA=0,pRA=0,cumO=0,pRO=0;
  months.forEach(mo=>{
    cumA+=mo.ads; const rA=Math.round(cumA); mo.adsW=rA-pRA; pRA=rA;
    cumO+=mo.organic; const rO=Math.round(cumO); mo.orgW=rO-pRO; pRO=rO;
  });
  const adsWinsYrInt=pRA;
  /* THE FUNNEL (HOTH-referenced, Aug 17): clicks → leads → customers + margin-adjusted profit.
     Leads are never capacity-capped; e-commerce (leadclose null) has no lead stage. */
  const lc=q.leadclose??null;
  const clicksMo=(cpc>0&&budget>0)?budget/cpc:0;
  const leadsMo=(lc&&clicksMo>0)?clicksMo*(close/lc):null;
  const cpl=(leadsMo>0)?budget/leadsMo:null;
  const mgnPct=Math.max(5,(q.margin||0)-(q.commission||0));   // effective keep-rate (margin net of the client's own sales commission)
  const grossMo=adFull*q.yearlyValue*(mgnPct||0)/100;
  const netMo=grossMo-(budget+fee(budget));
  return {adCAC, allInCAC, cacEff, acqAllowed, acqStated, paybackAllow, paybackMo, ltvCac, adsViable, veryEfficient, roomAtPace, noRoom, budgetAuto, budget, fee:fee(budget),
          adFull, roiAds, clickCeil, floorB, demandLimited, scaleMode, taperStart,
          taperDone:taperStart!=null?Math.min(12,taperStart+2):null, rampFull, organicOn, months,
          adsWinsYr, adsCostYr, adsWinsYrInt, lagM,
          leadClose:lc, clicksMo, leadsMo, cpl, mgnPct, grossMo, netMo};
}

/* ---------- tiny test kit ---------- */
let PASS=0, FAIL=0;
const near=(a,b,eps)=>Math.abs(a-b)<=(eps==null?1e-9:eps);
function t(name, cond, detail){
  if(cond){ PASS++; console.log('  ok    '+name); }
  else { FAIL++; console.log('  FAIL  '+name+(detail!=null?'  ->  '+detail:'')); }
}

/* ---------- edge tests (pure — mirror the spec's edge list) ---------- */
function edgeTests(){
  console.log('\n== edge tests (independent spec mirror) ==');
  const base={cpcEff:12, closeRate:0.015, yearlyValue:3000, capStretch:37.5, newCust:8,
              vol:1200, capApplied:false, nScopes:2, rampMonth:4, rampSpan:3, contractStyle:false};

  // -- viability: a margin-less fixture (cpc12/conv1.5%) -> CAC $800 vs max(15% x $3,000 = $450, 5%-keep payback $75) -> INVIABLE
  let a=independent(base,15,null);
  t('inviable vertical: adCAC computed', near(a.adCAC,800));
  t('inviable vertical: not viable', !a.adsViable);
  t('inviable vertical: auto budget is $0', a.budgetAuto===0);
  t('inviable vertical: fee $0 at $0 budget', a.fee===0);

  // -- fee-aware viability: media CAC squeaks under the limit, but all-in CAC does not
  const loc={...base, cpcEff:6, closeRate:0.035, yearlyValue:1200, capStretch:75, newCust:20, vol:1100};
  a=independent(loc,15,null);
  t('fee-aware: media CAC ~171', near(a.adCAC,6/0.035,0.01));
  t('fee-aware: all-in CAC includes management', a.allInCAC>a.adCAC, a.allInCAC+' vs '+a.adCAC);
  t('fee-aware: not viable after management fee', !a.adsViable);
  t('fee-aware: auto budget is $0', a.budgetAuto===0, a.budgetAuto);

  // -- very efficient: ultra (cpc9/conv0.25% -> CAC 3600 vs 10% x 250k = 25k)
  const ult={...base, cpcEff:9, closeRate:0.0025, yearlyValue:250000, capStretch:0.77, newCust:0.3,
             vol:400, capApplied:false, contractStyle:true, rampMonth:5, rampSpan:4};
  a=independent(ult,10,null);
  t('ultra: very efficient', a.veryEfficient);
  t('ultra: scale mode (very efficient + demand headroom) -> no taper', a.scaleMode && a.taperStart==null);
  t('ultra: budget floor $500 applies (0.47 slots x $3,600 = $1,692 -> snap)', a.budgetAuto>=500 && a.budgetAuto%250===0, a.budgetAuto);

  // -- no remaining capacity: do not manufacture a $500 recommendation
  const capB={...loc, capApplied:true, newCust:75, capStretch:75};   // organic fills capacity at pace
  a=independent(capB,15,null);
  t('capacity filled: auto budget is $0', a.noRoom && a.budgetAuto===0, a.budgetAuto);

  // -- budget ceiling: tiny market -> ceiling binds below the floor and wins (hard cap)
  const tiny={...loc, vol:100, capStretch:75, newCust:2};            // ceil = 0.5 x 100 x $6 = $300
  a=independent(tiny,15,null);
  t('budget ceiling: hard cap beats the soft floor', a.budgetAuto<=300, a.budgetAuto+' vs ceil '+a.clickCeil);

  // -- fee schedule: floor, 15% band, threshold, 12% band
  t('fee floor: $1,000 spend -> $500 fee (15% = $150 -> floor)', independent(loc,15,1000).fee===500);
  t('fee 15% band: $6,000 -> $900', independent(loc,15,6000).fee===900);
  t('fee threshold: $15,000 -> 15% = $2,250', independent(loc,15,15000).fee===2250);
  t('fee 12% band: $20,000 -> $2,400', independent(loc,15,20000).fee===2400);
  t('fee rounds to $50', independent(loc,15,5100).fee===Math.round(5100*0.15/50)*50);

  // -- adCust: capped by capacity net of organic pace
  a=independent(capB,15,4000);
  const m12=a.months[11];
  t('adCust: month-12 ads wins ~0 when organic fills capacity', m12.ads<=0.01, m12.ads);
  t('adCust: month-1 ads wins capped at capStretch', a.months[0].ads<=capB.capStretch+1e-9);

  // -- taper sanity: capacity-bound -> taper starts rampFull+1, floor = max($500, 30%)
  a=independent(capB,15,4000);
  t('taper: starts the month after full organic ramp', a.taperStart===capB.rampMonth+capB.rampSpan-1+1, a.taperStart);
  t('taper: maintenance floor = max($500, 30% snapped)', a.floorB===Math.max(500,Math.round(4000*0.30/250)*250), a.floorB);
  t('taper: full budget through rampFull', a.months.slice(0,a.taperStart-1).every(x=>x.budget===4000));
  t('taper: reaches the floor by taperDone', a.months[a.taperDone-1].budget===a.floorB, a.months[a.taperDone-1].budget);
  t('taper: monotone non-increasing', a.months.every((x,i)=>i===0||x.budget<=a.months[i-1].budget+1e-9));

  // -- taper: demand-limited (viable but NOT very efficient) -> floor $0, organic replaces ads
  const dem={...loc, capApplied:false, newCust:10, capStretch:75};
  a=independent(dem,15,2000);
  t('taper: demand-limited floor is $0', !a.scaleMode ? a.floorB===0 : true, 'scaleMode='+a.scaleMode+' floorB='+a.floorB);
  if(a.taperStart!=null) t('taper: demand-limited budget reaches $0', a.months[11].budget===0, a.months[11].budget);

  // -- ads-only: no organic -> no taper, flat schedule
  const solo={...loc, nScopes:0, newCust:0};
  a=independent(solo,15,3000);
  t('ads-only: flat budget all 12 months', a.months.every(x=>x.budget===3000));
  t('ads-only: organic pace is 0 every month', a.months.every(x=>x.organic===0));
  t('ads-only ROI: value vs (budget+fee), month 1, no ramp',
    near(a.roiAds, Math.min(3000/6*0.035, solo.capStretch)*1200/(3000+a.fee), 1e-6), a.roiAds);

  // -- edited budget: verbatim, never snapped
  a=independent(loc,15,3200);
  t('edited budget kept verbatim (no $250 snap on manual)', a.budget===3200);

  // -- year-one totals: the combined stack's inputs are exact sums of the schedule
  a=independent(capB,15,4000);
  t('year totals: adsWinsYr = sum of monthly ads wins', near(a.adsWinsYr, a.months.reduce((x,mo)=>x+mo.ads,0)));
  t('year totals: adsCostYr = sum of monthly spend + fees', near(a.adsCostYr, a.months.reduce((x,mo)=>x+mo.budget+mo.fee,0)));
  a=independent(solo,15,3000);
  t('year totals: ads-only cost = 12 x (budget + fee)', near(a.adsCostYr, 12*(3000+a.fee)));

  // -- integer win schedules (Aug 14): whole customers every month, year adds up exactly
  a=independent(capB,15,4000);
  t('int schedule: every monthly ads win is a whole number >= 0', a.months.every(mo=>mo.adsW>=0&&mo.adsW===Math.round(mo.adsW)));
  t('int schedule: every monthly organic win is a whole number >= 0', a.months.every(mo=>mo.orgW>=0&&mo.orgW===Math.round(mo.orgW)));
  t('int schedule: monthly adsW sums to round(adsWinsYr)', a.months.reduce((x,mo)=>x+mo.adsW,0)===Math.round(a.adsWinsYr), a.months.map(mo=>mo.adsW).join(','));
  t('int schedule: adsWinsYrInt = round(adsWinsYr)', a.adsWinsYrInt===Math.round(a.adsWinsYr));
  a=independent(ult,10,null);
  t('int schedule (ultra, sparse): whole counts under 2/yr pacing', a.months.every(mo=>mo.adsW===Math.round(mo.adsW)) && a.months.reduce((x,mo)=>x+mo.adsW,0)===Math.round(a.adsWinsYr));
  a=independent(loc,15,null);
  t('int schedule: cumulative rounding never skips ahead of the true pace',
    (function(){let c=0,r=0;return a.months.every(mo=>{c+=mo.ads;r+=mo.adsW;return Math.abs(r-c)<=0.5+1e-9;});})());

  // -- CLOSING LAG (Aug 17): big-ticket wins trail the clicks by the sales cycle
  a=independent(loc,15,3000);
  t('lag: fast vertical (<$10k) lags 0 — wins from month 1', a.lagM===0 && a.months[0].ads>0);
  const mid={...loc, yearlyValue:12000};
  a=independent(mid,15,3000);
  t('lag: $10k+ ticket lags 1 — month 1 zero, month 2 at pace', a.lagM===1 && a.months[0].ads===0 && near(a.months[1].ads, a.adFull, 1e-9), a.months.slice(0,3).map(mo=>mo.ads).join(','));
  const big={...loc, yearlyValue:40000, contractStyle:true};
  a=independent(big,15,3000);
  t('lag: contract-style lags 2 — months 1-2 zero, month 3 at pace', a.lagM===2 && a.months[0].ads===0 && a.months[1].ads===0 && near(a.months[2].ads, a.adFull, 1e-9));
  const soloBig={...solo, yearlyValue:30000};
  a=independent(soloBig,15,3000);
  t('lag (ads-only, flat budget): months 3-12 all at full pace', a.lagM===2 && a.months.slice(2).every(mo=>near(mo.ads,a.adFull,1e-9)));
  const capBig={...loc, capApplied:true, newCust:20, capStretch:75, yearlyValue:40000, contractStyle:true};
  a=independent(capBig,15,4000);
  t('lag: pipeline keeps closing through the taper — taper-month wins reflect pre-taper spend (ceiling-capped)',
    a.taperStart!=null && near(a.months[a.taperStart-1].ads, Math.min(Math.min(4000,a.clickCeil)/6*0.035, Math.max(0,75-a.months[a.taperStart-1].organic)), 1e-6),
    a.taperStart!=null ? a.months[a.taperStart-1].ads : 'no taper');

  // -- AUDIT FIXES (Aug 17): B2B minimum lag; edited budgets never inflate wins past the ceiling
  const b2b={...loc, industry:'b2b', yearlyValue:8000};
  a=independent(b2b,15,3000);
  t('lag: B2B floors at 1 month even under $10k ticket', a.lagM===1 && a.months[0].ads===0 && a.months[1].ads>0);
  const over={...solo, vol:200};                    // ceil = 0.5 x 200 x $6 = $600
  a=independent(over,15,4000);
  t('ceiling: edited budget over the click ceiling — wins modeled from the ceiling, not the spend',
    near(a.months[5].ads, Math.min(600/6*0.035, over.capStretch), 1e-9), a.months[5].ads);
  t('ceiling: the over-spend still bills (cost honest, wins capped)', a.months[5].budget===4000);

  // -- THE FUNNEL (HOTH-referenced, Aug 17): clicks → leads → customers + profit identities
  const fun={...loc, leadclose:0.40, margin:50};
  a=independent(fun,15,3000);
  t('funnel: leads × lead-close = clicks × visit-close (identity)', near(a.leadsMo*0.40, a.clicksMo*fun.closeRate, 1e-9));
  t('funnel: CPL × leads = the budget', near(a.cpl*a.leadsMo, 3000, 1e-6));
  t('funnel: CPL = adCAC × lead-close (unit costs chain)', near(a.cpl, a.adCAC*0.40, 1e-6), a.cpl+' vs '+(a.adCAC*0.40));
  t('funnel: net profit = wins × value × margin − all-in cost', near(a.netMo, a.adFull*fun.yearlyValue*0.50-(3000+a.fee), 1e-6));
  const noLead={...fun, leadclose:null};
  a=independent(noLead,15,3000);
  t('funnel: e-commerce style (no lead stage) — leads and CPL are null', a.leadsMo===null && a.cpl===null);

  // -- EFFECTIVE KEEP-RATE (Aug 17): commission subtracts from margin in every profit figure
  const comm={...fun, commission:10};
  a=independent(comm,15,3000);
  t('keep-rate: commission subtracts from margin (50 − 10 = 40)', a.mgnPct===40 && near(a.netMo, a.adFull*comm.yearlyValue*0.40-(3000+a.fee), 1e-6));
  const commHi={...fun, margin:12, commission:10};
  a=independent(commHi,15,3000);
  t('keep-rate: floored at 5% so profit math never zeroes out', a.mgnPct===5);
}

/* ---------- live cross-check against the real calculator ---------- */
async function liveTests(htmlPath){
  const {chromium}=require('playwright');
  const path=require('path');
  const url='file://'+path.resolve(htmlPath);
  /* SITE-IS-LEAN LAW (Payton, Oct 6): the plain-English math moved off the site into the deck.
     pdfText(qs) builds the PDF for a quote link and returns its text (pdftotext), cached per link. */
  const _pdfCache={};
  const pdfText=async function(qs){
    if(_pdfCache[qs]) return _pdfCache[qs];
    await page.goto(url+qs,{waitUntil:'load'});
    await page.addScriptTag({path:'node_modules/jspdf/dist/jspdf.umd.min.js'});
    const b64=await page.evaluate(()=>new Promise((res,rej)=>{ const ro=window.openPdfPreview;
      window.openPdfPreview=function(u){ window.openPdfPreview=ro; fetch(u).then(r=>r.arrayBuffer()).then(ab=>{const a=new Uint8Array(ab);let z='';for(let i=0;i<a.length;i++)z+=String.fromCharCode(a[i]);res(btoa(z));}).catch(e=>rej(String(e))); };
      try{ buildPDF('preview'); }catch(e){ rej(e.message); } }));
    const fs=require('fs'), cp=require('child_process'), os=require('os'), pth=require('path');
    const f=pth.join(os.tmpdir(),'nr-harness-'+Date.now()+'.pdf'); fs.writeFileSync(f,Buffer.from(b64,'base64'));
    const txt=cp.execSync('pdftotext -layout "'+f+'" - 2>/dev/null').toString().replace(/\s+/g,' ');
    const info=cp.execSync('pdfinfo "'+f+'" 2>/dev/null').toString(), fonts=cp.execSync('pdffonts "'+f+'" 2>/dev/null').toString();
    _pdfMeta[qs]={pages:+(info.match(/Pages:\s+(\d+)/)||[])[1], size:(info.match(/Page size:\s+([^\n]+)/)||[])[1]||'', inter:(fonts.match(/Inter/g)||[]).length};
    try{ fs.unlinkSync(f); }catch(e){}
    _pdfCache[qs]=txt; return txt;
  };
  const _pdfMeta={};
  const fs=require('fs');
  const exe=['/opt/pw-browsers/chromium','/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
    .find(p=>{try{return fs.existsSync(p)&&fs.statSync(p).isFile();}catch(e){return false;}});
  const browser=await chromium.launch(exe?{executablePath:exe}:{});
  const page=await browser.newPage();
  console.log('\n== live cross-check: '+htmlPath+' ==');

  const CASES=[
    {name:'highticket defaults (med spa — viable on payback)', qs:'?industry=highticket&seo=1&geo=1&ads=1'},
    {name:'saas realistic (inviable: $45 clicks, 0.4%)', qs:'?industry=b2b&cpc=45&convrate=0.4&yearly=6000&seo=1&geo=1&ads=1'},
    {name:'local defaults (viable)',        qs:'?industry=local&seo=1&geo=1&ads=1'},
    {name:'ultra (very efficient, event)',  qs:'?industry=ultra&seo=1&geo=1&ads=1'},
    {name:'capacity-bound med spa',         qs:'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2000&capacity=20&acq=15&seo=1&geo=1&ads=1'},
    {name:'edited budget',                  qs:'?industry=local&seo=1&geo=1&ads=1&adbudget=3200'},
    {name:'ads-only',                       qs:'?industry=local&seo=0&geo=0&ads=1&adbudget=3000'},
    {name:'big-ticket lag (real-estate style)', qs:'?industry=highticket&footprint=metro&cpc=4&volume=5000&capacity=2&yearly=40000&convrate=0.1&acq=15&seo=1&geo=1&ads=1'},
  ];
  for(const c of CASES){
    await page.goto(url+c.qs+'&stay=1',{waitUntil:'load'});
    const got=await page.evaluate(()=>{
      const s=readState(), q=computeQuote(s), n=getNegotiated(q);
      const a=adsState(s,q,n.rampMonth);
      return {a, q:{cpcEff:q.cpcEff, closeRate:q.closeRate, yearlyValue:q.yearlyValue,
                    capStretch:q.capStretch, newCust:q.newCust, vol:q.vol, capApplied:q.capApplied,
                    nScopes:q.nScopes, rampMonth:n.rampMonth, rampSpan:q.rampSpan,
                    contractStyle:q.contractStyle, industry:s.industry,
                    leadclose:BENCH(s).leadclose??null, margin:(s.margin??BENCH(s).margin), commission:(s.commission||0),
                    retainYears:q.retainYears, paidconv:(BENCH(s).paidconv??1)},
              acq:s.acq, dirty:adBudgetDirty,
              budgetField:(document.getElementById('adbudget').value||'').replace(/[^0-9.]/g,'')};
    });
    const exp=independent(got.q, got.acq, got.dirty? parseFloat(got.budgetField)||0 : null);
    const same=(k,eps)=>{
      const va=got.a[k], vb=exp[k];
      const ok=(va==null&&vb==null)||(typeof va==='number'&&typeof vb==='number'? near(va,vb,eps||1e-6) : va===vb);
      t(c.name+': '+k+' matches', ok, JSON.stringify(va)+' vs '+JSON.stringify(vb));
    };
    ['adCAC','allInCAC','roomAtPace','noRoom','acqAllowed','acqStated','paybackAllow','paybackMo','ltvCac','adsViable','veryEfficient','budgetAuto','budget','fee','adFull','floorB','taperStart','taperDone','adsWinsYr','adsCostYr','adsWinsYrInt','lagM','leadClose','clicksMo','leadsMo','cpl','grossMo','netMo'].forEach(k=>same(k,0.01));
    const mOk=got.a.months.every((mo,i)=>near(mo.budget,exp.months[i].budget,0.01)&&near(mo.fee,exp.months[i].fee,0.01)
              &&near(mo.ads,exp.months[i].ads,1e-4)&&near(mo.organic,exp.months[i].organic,1e-4)
              &&mo.adsW===exp.months[i].adsW&&mo.orgW===exp.months[i].orgW);
    t(c.name+': 12-month schedule matches (incl. integer wins)', mOk);
  }

  /* rev-share interplay: toggling ads must not move the organic quote, share, or invoice —
     ads-won customers are NEVER rev-share billed */
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2000&capacity=20&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const off=await page.evaluate(()=>{const s=readState(),q=computeQuote(s),n=getNegotiated(q);
    return {price:n.price, share:n.share, invoice:n.series.invoice, cust:q.newCust};});
  await page.evaluate(()=>{document.getElementById('scopeAds').checked=true; render();});
  const on=await page.evaluate(()=>{const s=readState(),q=computeQuote(s),n=getNegotiated(q);
    return {price:n.price, share:n.share, invoice:n.series.invoice, cust:q.newCust,
            card:document.getElementById('ads-card').textContent};});
  t('rev-share interplay: fixed price unchanged by ads toggle', off.price===on.price);
  t('rev-share interplay: share % unchanged by ads toggle', off.share===on.share);
  t('rev-share interplay: 12-month invoice unchanged by ads toggle', JSON.stringify(off.invoice)===JSON.stringify(on.invoice));
  t('rev-share interplay: organic win pace unchanged', off.cust===on.cust);
  t('rev-share exclusion stated on the site card', /never rev-share billed/.test(on.card));

  /* link round-trip: copyQuoteLink params reload to the same ads state */
  await page.goto(url+'?industry=local&seo=1&geo=1&ads=1&adbudget=2750&stay=1',{waitUntil:'load'});
  const link=await page.evaluate(()=>{
    const p=new URLSearchParams();
    // reuse the real serializer by intercepting the clipboard write
    let captured=null;
    const orig=navigator.clipboard&&navigator.clipboard.writeText;
    navigator.clipboard.writeText=t=>{captured=t;return Promise.resolve();};
    copyQuoteLink();
    if(orig) navigator.clipboard.writeText=orig;
    return captured;
  });
  t('link round-trip: ads=1 travels', /[?&]ads=1/.test(link||''), link);
  t('link round-trip: edited adbudget travels', /[?&]adbudget=2750/.test(link||''), link);
  const qs2=(link||'').split('?')[1]||'';
  await page.goto(url+'?'+qs2+'&stay=1',{waitUntil:'load'});
  const rt=await page.evaluate(()=>({on:document.getElementById('scopeAds').checked,
    dirty:adBudgetDirty, v:(document.getElementById('adbudget').value||'').replace(/[^0-9]/g,'')}));
  t('link round-trip: toggle restored', rt.on===true);
  t('link round-trip: budget restored as edited', rt.dirty===true && rt.v==='2750', JSON.stringify(rt));

  /* toggle-off state: no card, no ads-math section (the budget input lives inside it) */
  await page.goto(url+'?industry=local&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const offUi=await page.evaluate(()=>({card:document.getElementById('ads-card').hidden,
    sec:document.getElementById('sec-ads').hidden}));
  t('toggle off: ads card hidden', offUi.card===true);
  t('toggle off: ads budget section hidden', offUi.sec===true);

  /* flat-retainer mode: no rev-share talk anywhere on the ads surfaces */
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&revshare=0&stay=1',{waitUntil:'load'});
  const flat=await page.evaluate(()=>({
    card:document.getElementById('ads-card').textContent,
    sum:document.getElementById('o-summary').textContent,
    sec:document.getElementById('sec-ads').hidden,
    priceSub:document.getElementById('o-price-sub').textContent}));
  const noShare=s=>!/rev[- ]?share|revenue share|share-free|% share|of share|share starts|share begins|no share|the share /i.test(s);
  t('flat mode: ads budget section visible', flat.sec===false);
  t('flat mode: no rev-share talk on the ads card', noShare(flat.card), flat.card.slice(0,200));
  const flatPdf=await pdfText('?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&revshare=0&stay=1');
  t('flat mode: no rev-share talk in the PDF ads math', noShare(flatPdf.slice(flatPdf.indexOf('The Ads Math'), flatPdf.indexOf('The 12-Month Projection'))), 'ads-math pages');
  t('flat mode: no rev-share talk in the summary', noShare(flat.sum));
  t('flat mode: fee subtitle has no share/drop talk', noShare(flat.priceSub) && !/drops/i.test(flat.priceSub), flat.priceSub);

  /* FULL visible-page sweep in flat mode — every vertical style, the whole rendered page.
     The rev-share toggle row itself (the control + its hover tip) is the ONE allowed mention. */
  for(const fc of [{n:'flat monthly', qs:'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&revshare=0&stay=1'},
                   {n:'flat ultra (contract-style)', qs:'?industry=ultra&yearly=50000&seo=1&geo=1&ads=1&revshare=0&stay=1'},
                   {n:'flat local no-ads', qs:'?industry=local&seo=1&geo=1&revshare=0&stay=1'}]){
    await page.goto(url+fc.qs,{waitUntil:'load'});
    const vis=await page.evaluate(()=>{
      const row=document.querySelector('label[for="scopeShare"]');
      const saved=row?row.outerHTML:''; if(row) row.remove();   // the toggle control is exempt
      const txt=document.querySelector('.wrap').innerText.replace(/\s+/g,' ');
      if(row) document.querySelector('#scope-warn').insertAdjacentHTML('beforebegin',saved);
      return txt;
    });
    const m=vis.match(/rev[- ]?share|revenue share|share-free|% share|of share|share starts|share begins|no share/gi);
    t(fc.n+': whole visible page free of rev-share talk', !m, m?[...new Set(m)].join('|'):'');
  }

  /* share mode: section 06 states the exclusion + explains the budget with live numbers */
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const shr=await page.evaluate(()=>({inSec:!!document.querySelector('#sec-ads #adbudget')}));
  const shrPdf=await pdfText('?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&stay=1');
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  t('share mode: PDF ads math states the rev-share exclusion', /never rev-share billed/.test(shrPdf));
  t('share mode: PDF ads math explains CAC and guardrails', /clicks become customers/i.test(shrPdf) && /guardrail/i.test(shrPdf));
  t('budget input lives inside the ads budget section', shr.inSec===true);

  /* the combined stack: organic + ads + all-in on the card, numbers reconciling exactly */
  const stk=await page.evaluate(()=>{
    const s=readState(), q=computeQuote(s), n=getNegotiated(q);
    const a=adsState(s,q,n.rampMonth);
    return {card:document.getElementById('ads-card').textContent,
            allIn:n.price+a.budget+a.fee, price:n.price, budget:a.budget, fee:a.fee,
            roiSub:document.getElementById('o-roi-sub').textContent,
            tl:document.getElementById('o-timeline').textContent,
            svg:document.getElementById('o-chart').innerHTML,
            legAds:document.getElementById('legend-ads').hidden,
            legCost:document.getElementById('legend-cost').textContent,
            cs:{inv:chartSeries.inv, adsC:chartSeries.adsC, allInArr:chartSeries.allIn, ads:chartSeries.ads}};
  });
  const money=v=>'$'+Math.round(v).toLocaleString('en-US');
  t('stack: PDF shows the combined all-in month-1 price', shrPdf.indexOf(money(stk.allIn))>=0 && /All-in, month 1/.test(shrPdf), money(stk.allIn));
  t('stack: PDF lists both prices separately', shrPdf.indexOf(money(stk.price))>=0 && shrPdf.indexOf(money(stk.budget))>=0);
  t('stack: PDF shows the combined year-one line', /Year one, combined/.test(shrPdf));
  t('stack: the site card is lean — no stack block, no funnel paragraph (PDF-only now)', !/Year one, combined/.test(stk.card) && !/The funnel:/.test(stk.card), stk.card.slice(0,200));
  /* Sept 28 (channel fit) + Oct 6 (lean site): the headline sub names each channel alone, in one line */
  t('separation: ROI sub names each channel alone when ads are on', /SEO\/GEO alone [\d.–]+× · ads alone [\d.]+×/.test(stk.roiSub), stk.roiSub.slice(-200));
  t('separation: ROI sub is one lean line (the math is in the PDF)', stk.roiSub.length<260 && /Full math in the PDF/.test(stk.roiSub), String(stk.roiSub.length));
  t('chart: one-line legend names the blue ads segments', /blue = ads wins/i.test(stk.tl), stk.tl);
  t('chart: blue ads segments drawn in the SVG', /bar-ads/.test(stk.svg));
  t('chart: ads legend key visible, cost key reads all-in', stk.legAds===false && /All-in cost/.test(stk.legCost), stk.legCost);
  t('chart: all-in series = organic bill + ads cost, every month',
    stk.cs.allInArr.every((v,i)=>Math.abs(v-((stk.cs.inv[i]||0)+stk.cs.adsC[i]))<0.01));
  t('chart: ads value series present for 12 months', Array.isArray(stk.cs.ads)&&stk.cs.ads.length===12);

  /* integer-display law (Payton, Aug 14): no fractional customer counts anywhere a client
     looks, in any ads-on vertical — and the chart series carries whole wins + the bill split */
  for(const fc of [{n:'ultra ads-on', qs:'?industry=ultra&yearly=50000&seo=1&geo=1&ads=1&stay=1'},
                   {n:'capacity-bound ads-on', qs:'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2000&capacity=20&seo=1&geo=1&ads=1&stay=1'},
                   {n:'ads-only', qs:'?industry=local&seo=0&geo=0&ads=1&adbudget=3000&stay=1'}]){
    await page.goto(url+fc.qs,{waitUntil:'load'});
    const vis=await page.evaluate(()=>document.querySelector('.wrap').innerText.replace(/\s+/g,' '));
    const m=vis.match(/\d+\.\d+\s*(more\s+)?(new\s+)?customers?\b/gi);
    t(fc.n+': no fractional customer counts on the page', !m, m?[...new Set(m)].join('|'):'');
  }
  await page.goto(url+'?industry=ultra&yearly=50000&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const csInt=await page.evaluate(()=>{const cs=chartSeries; return cs&&cs.ads?{ok:true,
    aw:cs.adsW.every(v=>v===Math.round(v)&&v>=0), b:cs.adsB[0], f:cs.adsF[0], inv:cs.inv[0], allIn:cs.allIn[0],
    sum:cs.adsW.reduce((x,v)=>x+v,0)}:{ok:false};});
  t('chart series: ads wins are whole numbers every month', csInt.ok&&csInt.aw);
  t('chart series: program + spend + fee = all-in (month 1, the tooltip equation)',
    csInt.ok&&Math.abs(csInt.inv+csInt.b+csInt.f-csInt.allIn)<0.01,
    csInt.ok?csInt.inv+'+'+csInt.b+'+'+csInt.f+' vs '+csInt.allIn:'no ads series');

  /* the zoom: legend + plain-words guide travel into the enlarged view; flat-mode zoom
     stays share-free (title and guide are dynamic, never the old static "(fixed + share)") */
  await page.goto(url+'?industry=ultra&yearly=50000&seo=1&geo=1&ads=1&revshare=0&stay=1',{waitUntil:'load'});
  const zoom=await page.evaluate(()=>{openChartZoom(); const r={
    title:document.getElementById('cz-title').textContent,
    body:document.getElementById('cz-body').innerText.replace(/\s+/g,' '),
    hasKey:!!document.querySelector('#cz-body .cz-key'),
    hasGuide:!!document.querySelector('#cz-body .cz-guide')}; closeChartZoom(); return r;});
  t('zoom: legend rendered inside the zoom view', zoom.hasKey);
  t('zoom: plain-words reading guide present', zoom.hasGuide);
  t('zoom: guide spells out the all-in addition', /whole bill, added up/i.test(zoom.body), zoom.body.slice(0,160));
  t('zoom (flat): no share vocabulary in title or guide', !/share/i.test(zoom.title+' '+zoom.body), zoom.title);
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const zoom2=await page.evaluate(()=>{openChartZoom(); const r={
    title:document.getElementById('cz-title').textContent,
    hasGuide:!!document.querySelector('#cz-body .cz-guide')}; closeChartZoom(); return r;});
  t('zoom (share, no ads): title mirrors the live cost legend', /fixed \+ share/i.test(zoom2.title), zoom2.title);
  t('zoom (share, no ads): guide present without ads talk', zoom2.hasGuide);

  /* CHANNEL-LABEL LAW (Payton, Aug 17): with ads on, every output is grouped/labeled
     SEO/GEO or combined — and reverts cleanly when ads is off */
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const lbl=await page.evaluate(()=>({
    kick:document.getElementById('o-kicker').textContent,
    price:document.getElementById('o-price-lbl').textContent,
    share:document.getElementById('o-share-lbl').textContent,
    proj:document.getElementById('o-proj-label').textContent,
    ocHidden:document.getElementById('ocards-kicker').hidden,
    ocTxt:document.getElementById('ocards-kicker').textContent}));
  t('labels: revenue-ROAS kicker says SEO/GEO + ads, combined (channel-fit headline)', /revenue ROAS — SEO\/GEO \+ ads, combined/i.test(lbl.kick), lbl.kick);
  t('labels: price label says SEO/GEO', /^SEO\/GEO fixed/.test(lbl.price), lbl.price);
  t('labels: share label says organic wins only', /organic wins only/.test(lbl.share), lbl.share);
  t('labels: projection label says combined', /SEO\/GEO \+ ads combined/.test(lbl.proj), lbl.proj);
  t('labels: pace-cards group kicker visible + SEO/GEO', lbl.ocHidden===false && /SEO\/GEO program — organic pace/.test(lbl.ocTxt));
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&revshare=0&stay=1',{waitUntil:'load'});
  const lblF=await page.evaluate(()=>({fan:document.getElementById('flat-ads-note').textContent,
    shareRowHidden:!!document.getElementById('share-row').closest('[hidden]')||document.getElementById('share-row').hidden||getComputedStyle(document.getElementById('share-row')).display==='none'}));
  t('labels (flat): flat block notes ads billed separately', /separate line/.test(lblF.fan), lblF.fan);
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const lblOff=await page.evaluate(()=>({
    kick:document.getElementById('o-kicker').textContent,
    price:document.getElementById('o-price-lbl').textContent,
    proj:document.getElementById('o-proj-label').textContent,
    ocHidden:document.getElementById('ocards-kicker').hidden,
    fan:document.getElementById('flat-ads-note').textContent}));
  t('labels control (ads off): kicker says revenue ROI (return-word law: ROI without ads)', lblOff.kick==='Projected Revenue ROI', lblOff.kick);
  t('labels control (ads off): price label plain', lblOff.price==='Fixed monthly investment');
  t('labels control (ads off): projection label plain', lblOff.proj==='12-Month Projection');
  t('labels control (ads off): pace-cards kicker hidden + flat note empty', lblOff.ocHidden===true && lblOff.fan==='');

  /* Internal visibility scores are authoritative inputs. Rank affects difficulty/ramp only,
     and geographically bounded B2B links keep the footprint they were researched for. */
  await page.goto(url+'?industry=b2b&footprint=local&rank=1&seoScore=12&geoScore=4&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const auth=await page.evaluate(()=>{const s=readState(),q=computeQuote(s); return {
    footprint:s.footprint, seoEntered:q.seoEntered, seoEff:q.seoEff,
    options:[...document.getElementById('footprint').options].map(o=>({v:o.value,d:o.disabled})),
    note:document.getElementById('note-seo').innerText.replace(/\s+/g,' ')};});
  t('audit score: calculator uses entered SEO score exactly despite rank 1', auth.seoEntered===12 && auth.seoEff===12, JSON.stringify(auth));
  t('audit score: UI states the audit scores are used as entered', /used (directly|as entered)/i.test(auth.note), auth.note);
  t('B2B footprint: local researched scope remains local', auth.footprint==='local', auth.footprint);
  t('B2B footprint: all footprint choices remain available', auth.options.every(o=>!o.d), JSON.stringify(auth.options));

  /* equal bills draw equal bars (Payton, Aug 17): contract-style chart, ads on — any two
     months with the same all-in bill must render cost bars of the same height */
  await page.goto(url+'?industry=ultra&yearly=50000&seo=1&geo=1&ads=1&revshare=0&stay=1',{waitUntil:'load'});
  const eq=await page.evaluate(()=>{
    const cs=chartSeries; if(!cs||!cs.allIn) return {ok:false,why:'no ads series'};
    const hs=[...document.querySelectorAll('#o-chart .bar-cost')].map(r=>parseFloat(r.getAttribute('height')));
    if(hs.length!==12) return {ok:false,why:'expected 12 cost bars, got '+hs.length};
    for(let i=0;i<12;i++)for(let j=i+1;j<12;j++){
      if(Math.abs(cs.allIn[i]-cs.allIn[j])<0.5 && Math.abs(hs[i]-hs[j])>0.15)
        return {ok:false,why:'months '+(i+1)+'/'+(j+1)+' bill '+cs.allIn[i]+' but heights '+hs[i]+'/'+hs[j]};
    }
    return {ok:true};
  });
  t('chart: equal all-in bills render equal cost-bar heights', eq.ok, eq.why||'');

  /* CLOSING-LAG UI (Payton, Aug 17: "2 new customers every month starting month 1...
     seems overpromising"): big-ticket quotes stop claiming month-1 closings */
  await page.goto(url+'?industry=highticket&footprint=metro&cpc=4&volume=5000&capacity=2&yearly=40000&convrate=0.1&acq=15&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const lagUi=await page.evaluate(()=>{
    const s=readState(), q=computeQuote(s), n=getNegotiated(q), a=adsState(s,q,n.rampMonth);
    return {card:document.getElementById('ads-card').innerText.replace(/\s+/g,' '),
            lag:a.lagM, m12:a.months.map(x=>x.adsW).join(',')};
  });
  const lagPdf=await pdfText('?industry=highticket&footprint=metro&cpc=4&volume=5000&capacity=2&yearly=40000&convrate=0.1&acq=15&seo=1&geo=1&ads=1&stay=1');
  t('lag UI: big-ticket quote lags 2 months', lagUi.lag===2);
  t('lag UI: card no longer claims "month 1, no ramp"', !/month 1, no ramp/i.test(lagUi.card), lagUi.card.slice(0,260));
  t('lag UI: card says first closings ~month 3', /first closings (land )?(~|around )?month 3/i.test(lagUi.card), lagUi.card.slice(0,400));
  t('lag UI: PDF ads math carries the honest timing note', /timing note/i.test(lagPdf) && /month 3/.test(lagPdf));
  t('lag UI: schedule wins months 1-2 are zero', lagUi.m12.split(',').slice(0,2).join(',')==='0,0', lagUi.m12);
  /* fast vertical control: local keeps its month-1 delivery claim */
  await page.goto(url+'?industry=local&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const lagC=await page.evaluate(()=>{
    const s=readState(), q=computeQuote(s), n=getNegotiated(q), a=adsState(s,q,n.rampMonth);
    return {lag:a.lagM, card:document.getElementById('ads-card').innerText.replace(/\s+/g,' ')};
  });
  t('lag control: local service lags 0 and keeps "from month 1"', lagC.lag===0 && /· from month 1/i.test(lagC.card), lagC.card.slice(0,240));

  /* THE FUNNEL on the surfaces (HOTH-referenced, Aug 17) */
  await page.goto(url+'?industry=local&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const fun1=await page.evaluate(()=>({card:document.getElementById('ads-card').innerText.replace(/\s+/g,' ')}));
  const fun1Pdf=await pdfText('?industry=local&seo=1&geo=1&ads=1&stay=1');
  t('funnel: PDF ads plan shows clicks → qualified opportunities → customers', /THE FUNNEL: [\d,]+ clicks\/mo → ~[\d,]+ qualified opportunities \(\$[\d,]+ each\) → /.test(fun1Pdf), fun1Pdf.slice(fun1Pdf.indexOf('THE FUNNEL'),fun1Pdf.indexOf('THE FUNNEL')+200));
  t('funnel: PDF shows the net-after-margin line', /\/mo net profit at the client|break-even/.test(fun1Pdf));
  t('funnel: PDF ads math walks qualified opportunities with cost each', /become qualified opportunities/.test(fun1Pdf) && /per opportunity/.test(fun1Pdf));
  t('funnel: PDF ads math distinguishes raw web leads from qualified opportunities', /raw web leads run far higher/.test(fun1Pdf));
  t('funnel: PDF ads math has the profit-terms line', /in profit terms/i.test(fun1Pdf));
  t('ROAS: card labels the ads multiple as ROAS, revenue before margin', /[\d.]+× ROAS \(revenue, before margin\)/.test(fun1.card), fun1.card.slice(0,300));
  await page.goto(url+'?industry=ecom&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const fun2=await page.evaluate(()=>({card:document.getElementById('ads-card').innerText.replace(/\s+/g,' ')}));
  const fun2Pdf=await pdfText('?industry=ecom&seo=1&geo=1&ads=1&stay=1');
  t('funnel (ecom): no opportunity stage on the card', !/opportunities \(/.test(fun2.card), fun2.card.slice(0,260));
  t('funnel (ecom): PDF ads math says buyers purchase directly', /purchase directly|no lead stage/i.test(fun2Pdf));

  /* the revenue card reframes for one-time-sale verticals (Payton, Aug 17: "+$956/mo
     next to $138k/yr" is a contradiction when customers pay once) */
  await page.goto(url+'?industry=highticket&footprint=metro&cpc=4&volume=5000&capacity=2&yearly=40000&convrate=0.1&acq=15&years=1&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const rc1=await page.evaluate(()=>({lbl:document.getElementById('o-arrpm-label').textContent,
    val:document.getElementById('o-arrpm').textContent, note:document.getElementById('o-arrpm-note').textContent}));
  t('revenue card (one-time): label is contract value per year', rc1.lbl==='New contract value / year', rc1.lbl);
  t('revenue card (one-time): value is a /yr figure, no fake MRR', /\/yr$/.test(rc1.val), rc1.val);
  t('revenue card (one-time): note says one-time sales, not recurring', /one-time sales, not recurring/.test(rc1.note), rc1.note);
  await page.goto(url+'?industry=local&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const rc2=await page.evaluate(()=>({lbl:document.getElementById('o-arrpm-label').textContent}));
  t('revenue card (recurring control): local keeps recurring revenue / mo', rc2.lbl==='New recurring revenue / mo', rc2.lbl);

  /* margin-aware "wins cover the year" + combined stack ROAS/net + industry AI factors (Aug 17) */
  await page.goto(url+'?industry=ultra&yearly=50000&seo=1&geo=1&ads=1&revshare=0&stay=1',{waitUntil:'load'});
  const mw=await page.evaluate(()=>({tl:document.getElementById('o-timeline').innerText.replace(/\s+/g,' '),
    card:document.getElementById('ads-card').innerText.replace(/\s+/g,' ')}));
  const mwPdf=await pdfText('?industry=ultra&yearly=50000&seo=1&geo=1&ads=1&revshare=0&stay=1');
  t('margin-aware cover claim: no flat "covers the program many times over"', !/covers the program many times over/.test(mwPdf+mw.tl), mw.tl.slice(0,200));
  t('margin-aware cover claim: transactions-cover phrasing present in the PDF', /(One win pays for the entire year.*gross profit at the modeled margin|average closed transactions more than cover)/.test(mwPdf));
  t('site timeline is one lean line (the reading guide lives in the PDF)', mw.tl.length<330 && /reading guide is in the PDF/.test(mw.tl), String(mw.tl.length));
  t('stack: PDF combined multiple labeled revenue ROAS (net line prints only when positive)', /revenue ROAS, before margin/.test(mwPdf) && /(net profit at the client|The combined 12-month chart)/.test(mwPdf), mwPdf.slice(mwPdf.indexOf('Year one, combined'),mwPdf.indexOf('Year one, combined')+300));
  await page.goto(url+'?industry=b2b&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const ai1=await page.evaluate(()=>computeQuote(readState()).aiLift);
  await page.goto(url+'?industry=local&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const ai2=await page.evaluate(()=>computeQuote(readState()).aiLift);
  t('AI demand lift varies by vertical (b2b 1.18 vs local 1.08)', Math.abs(ai1-1.18)<1e-9 && Math.abs(ai2-1.08)<1e-9, ai1+' / '+ai2);
  /* ONE ORGANIC PROGRAM (Payton, Sept 16: "seo is foundational for geo… doing them separately
     won't make sense") — the two scope switches are gone; one switch drives both, and any
     legacy link carrying either scope loads the whole program */
  await page.goto(url+'?industry=b2b&seo=0&geo=1&stay=1',{waitUntil:'load'});
  const op1=await page.evaluate(()=>{const s=readState(),q=computeQuote(s); return {n:q.nScopes, seo:s.seo, geo:s.geo, conv:q.aiConvLift,
    vis:!!document.getElementById('scopeOrganic'), seoHidden:document.getElementById('scopeSeo').hidden, geoHidden:document.getElementById('scopeGeo').hidden, on:document.getElementById('scopeOrganic').checked};});
  t('one program: a legacy GEO-only link upgrades to the full SEO + AEO/GEO program', op1.n===2 && op1.seo && op1.geo && op1.on, JSON.stringify(op1));
  t('one program: AI close premium is the dual-program slice, never the GEO-only 1.55', op1.conv>1 && op1.conv<1.55, op1.conv);
  t('one program: a single organic switch is visible and the old two are hidden mirrors', op1.vis && op1.seoHidden && op1.geoHidden);
  await page.goto(url+'?industry=local&organic=0&ads=1&adbudget=2000&stay=1',{waitUntil:'load'});
  const op2=await page.evaluate(()=>{const s=readState(),q=computeQuote(s); return {n:q.nScopes, on:document.getElementById('scopeOrganic').checked, price:q.price};});
  t('one program: organic=0 (or seo=0&geo=0) is the ads-only quote', op2.n===0 && !op2.on && op2.price==null, JSON.stringify(op2));
  await page.goto(url+'?industry=local&stay=1',{waitUntil:'load'});
  const op3=await page.evaluate(()=>{ const sw=document.getElementById('scopeOrganic'); sw.checked=false; sw.dispatchEvent(new Event('change',{bubbles:true}));
    const a=computeQuote(readState()).nScopes; sw.checked=true; sw.dispatchEvent(new Event('change',{bubbles:true})); const b=computeQuote(readState()).nScopes; return {off:a,on:b, seo:document.getElementById('scopeSeo').checked, geo:document.getElementById('scopeGeo').checked}; });
  t('one program: flipping the switch drives both mirrors (0 scopes off, 2 on)', op3.off===0 && op3.on===2 && op3.seo && op3.geo, JSON.stringify(op3));
  const lblOP=await page.evaluate(()=>document.body.innerText);
  t('one program: no separate "SEO included" / "AEO / GEO included" rows on the page', !/SEO included|AEO \/ GEO included/.test(lblOP) && /SEO \+ AEO\/GEO program included/.test(lblOP));

  /* commission → effective keep-rate on the surfaces (Payton, Aug 17: "are you mistaking the
     sales commission input for the percent he charges?") */
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&commission=10&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const kc1=await page.evaluate(()=>{const s=readState(),q=computeQuote(s),n=getNegotiated(q);
    return {mgn:adsState(s,q,n.rampMonth).mgnPct};});
  const kc1Pdf=await pdfText('?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&commission=10&seo=1&geo=1&ads=1&stay=1');
  t('keep-rate UI: commission 10 on 65% margin → 55% effective', kc1.mgn===55, kc1.mgn);
  t('keep-rate UI: PDF profit line says effective margin when commission > 0', /effective margin \(after their sales commission\)/.test(kc1Pdf), kc1Pdf.slice(-300));
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&commission=0&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const kc2=await page.evaluate(()=>{const s=readState(),q=computeQuote(s),n=getNegotiated(q);
    return {mgn:adsState(s,q,n.rampMonth).mgnPct};});
  const kc2Pdf=await pdfText('?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&commission=0&seo=1&geo=1&ads=1&stay=1');
  t('keep-rate UI: commission 0 → full 65% margin, plain "margin" word', kc2.mgn===65 && !/effective margin \(after/.test(kc2Pdf));
  const tip=await page.evaluate(()=>document.querySelectorAll('#commission')[0].closest('.fgroup').querySelector('.tipbox').innerText.replace(/\s+/g,' '));
  t('commission tipbox: warns it is NOT the rate charged to customers', /NOT the rate the business charges its customers/i.test(tip));
  t('commission tipbox: states the output effect (margin minus this percentage)', /margin minus this percentage|effective keep-rate/i.test(tip));

  /* taper is a sidenote, never a suggestion (Payton, Aug 18: "make it merely a sidenote —
     many successful businesses still run ads heavily") */
  await page.goto(url+'?industry=local&volume=5000&cpc=14&yearly=1200&capacity=40&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});   // viable-but-not-cheap ads with room at pace → the taper case (very-efficient ads never taper; no-room zeroes the budget)
  const tn=await page.evaluate(()=>{const s=readState(),q=computeQuote(s),n=getNegotiated(q),a=adsState(s,q,n.rampMonth);
    return {taper:a.taperStart, card:document.getElementById('ads-card').innerText.replace(/\s+/g,' ')};});
  const tnPdf=await pdfText('?industry=local&volume=5000&cpc=14&yearly=1200&capacity=40&seo=1&geo=1&ads=1&stay=1');
  t('taper-sidenote: fixture actually tapers', tn.taper!=null, 'taperStart='+tn.taper);
  t('taper-sidenote: PDF ads math frames taper as default, not directive', /the default, not a directive/.test(tnPdf), tnPdf.slice(-420));
  t('taper-sidenote: PDF says businesses keep running ads to scale', /keep running ads heavily alongside strong organic/.test(tnPdf));
  t('taper-sidenote: PDF schedule note and honest answer carry the sidenote', /modeled default, not a (rule|directive)/.test(tnPdf), tnPdf.slice(tnPdf.indexOf('Sidenote'),tnPdf.indexOf('Sidenote')+200));
  t('taper-sidenote: no "paying for it twice" preaching anywhere', !/paying for it twice|stops making sense|instead of running forever/.test(tnPdf+tn.card));

  /* SCALABLE-DELIVERY LAW (Payton, Sept 15: "if the demand supports 226/mo it inputs 226 for
     situations like these") — borderless B2B, low-ticket transaction, capacity blank → the auto
     ceiling follows demand; every control stays human-bound */
  const MAP='?client=My+Accident+Payout&industry=b2b&footprint=nongeo&compstr=dominant&units=1&cpc=200&seo=1&geo=1&rank=50&seoScore=12&geoScore=5&volume=250000&volsource=aiprompt&yearly=300&years=1&convrate=2.5&margin=50&acq=15&commission=0&stay=1';
  const capQ=async(qs)=>{ await page.goto(url+qs,{waitUntil:'load'}); return page.evaluate(()=>{const s=readState(),q=computeQuote(s);
    return {sc:q.scalableDelivery, applied:q.capApplied, auto:q.capAuto, typ:q.capTypical, stretch:q.capStretch, demand:q.newCustDemand, newCust:q.newCust,
            note:document.getElementById('note-capacity').innerText.replace(/\s+/g,' ')};}); };
  const sd=await capQ(MAP);
  t('scalable-delivery: lead-gen funnel is recognized (b2b + nongeo + $300 ticket + blank capacity)', sd.sc===true, JSON.stringify(sd).slice(0,200));
  t('scalable-delivery: capacity no longer binds — projection equals the demand-supported pace', sd.applied===false && Math.abs(sd.newCust-sd.demand)<1e-9, 'newCust='+sd.newCust+' demand='+sd.demand);
  t('scalable-delivery: auto ceiling is the demand number (≥ the typical rung, ≥ demand)', sd.auto>=sd.typ && sd.auto>=sd.demand && sd.auto<sd.demand+1, 'auto='+sd.auto+' typ='+sd.typ);
  t('scalable-delivery: demand here is far above the old B2B rung (the bug that triggered the law)', sd.demand>100 && sd.typ===25, 'demand='+sd.demand+' typ='+sd.typ);
  t('scalable-delivery: the capacity note explains it follows demand', /scales with demand|follows the demand/i.test(sd.note), sd.note.slice(0,220));
  const sdA=await capQ(MAP+'&capacity=40');
  t('scalable-delivery control: a stated capacity always wins (40 → cap 60 binds)', sdA.sc===false && sdA.applied===true && sdA.stretch===60, JSON.stringify(sdA).slice(0,160));
  const sdB=await capQ('?industry=b2b&footprint=nongeo&volume=250000&cpc=200&rank=50&seoScore=12&geoScore=5&yearly=8000&years=4&convrate=2.5&seo=1&geo=1&stay=1');
  t('scalable-delivery control: an $8k/yr B2B customer stays human-bound (typical 25/mo rung)', sdB.sc===false && sdB.auto===25, JSON.stringify(sdB).slice(0,160));
  const sdC=await capQ('?industry=local&footprint=national&volume=250000&cpc=6&rank=50&seoScore=12&geoScore=5&yearly=300&years=1&convrate=2.5&seo=1&geo=1&stay=1');
  t('scalable-delivery control: a local-service business stays human-bound even nationally at $300', sdC.sc===false, JSON.stringify(sdC).slice(0,160));
  const sdD=await capQ('?industry=b2b&footprint=nongeo&volume=250000&cpc=200&rank=50&seoScore=12&geoScore=5&yearly=2000&years=1&convrate=2.5&seo=1&geo=1&stay=1');
  t('scalable-delivery control: a $2,000/yr B2B customer (above the $1,500 transaction line) stays human-bound', sdD.sc===false && sdD.auto===25, JSON.stringify(sdD).slice(0,160));

  /* BOOK CHECK (Payton, Sept 16 — Closer Launch): retained B2B services show the steady-state
     account count their intake implies; scalable-delivery and one-year verticals do not */
  const CL='?client=Closer+Launch&industry=b2b&footprint=nongeo&compstr=strong&units=1&cpc=12&seo=1&geo=1&rank=50&seoScore=12&geoScore=5&volume=5000&volsource=aiprompt&capacity=3&yearly=150000&years=2&convrate=0.75&margin=40&acq=20&commission=10&stay=1';
  const bk=await capQ(CL);
  const bkNum=(bk.note.match(/~(\d+) active accounts/)||[])[1];
  t('book check: Closer Launch note states the implied steady-state book', /Book check:/.test(bk.note) && bkNum!=null, bk.note.slice(-260));
  t('book check: the book equals pace × retention years × 12 (~107 here)', bkNum!=null && Math.abs(+bkNum-Math.round(bk.newCust*2*12))<=1, 'book='+bkNum+' pace='+bk.newCust);
  const bk1=await capQ(MAP);
  t('book check: absent for scalable-delivery lead-gen (one-year, automated)', !/Book check:/.test(bk1.note));
  const bk2=await capQ('?industry=highticket&yearly=12000&years=3&capacity=10&seo=1&geo=1&stay=1');
  t('book check: absent outside B2B (a med spa\'s patient book is not an account book)', !/Book check:/.test(bk2.note));

  /* CHANNEL FIT (Payton, Sept 28: "med spa, pest control, plumbing have a great ROAS on ads; a
     software company might not — the calculator must distinguish the two") */
  const cfQ=async(qs)=>{ await page.goto(url+qs,{waitUntil:'load'}); return page.evaluate(()=>{const s=readState(),q=computeQuote(s),n=getNegotiated(q),a=adsState(s,q,n.rampMonth),cf=channelFit(s,q,n,a);
    return {mode:cf.mode, viable:a.adsViable, veryEff:a.veryEfficient, basis:a.allowBasis, allow:a.acqAllowed, adCAC:a.adCAC, pb:a.paybackMo, ltv:a.ltvCac, paidConv:a.paidConv, roas:a.roiAds,
            comb:cf.comb?cf.comb.ret:null, org:cf.org?cf.org.ret:null, kicker:document.getElementById('o-kicker').innerText, roi:document.getElementById('o-roi').innerText,
            card:document.getElementById('ads-card').innerText.replace(/\s+/g,' '), roiSub:document.getElementById('o-roi-sub').innerText.replace(/\s+/g,' ')};}); };
  const spa=await cfQ('?industry=highticket&seo=1&geo=1&ads=1&stay=1');
  t('channel fit: med-spa preset is VIABLE on the payback rule (was "inefficient" at 15% of first-year value)', spa.viable && spa.basis==='payback' && spa.allow>spa.adCAC, JSON.stringify({allow:spa.allow,adCAC:spa.adCAC,basis:spa.basis}));
  t('channel fit: med-spa paid clicks convert at 90% of organic (adCAC = 12 ÷ 1.35%)', Math.abs(spa.paidConv-0.9)<1e-9 && Math.abs(spa.adCAC-12/0.0135)<0.01, spa.adCAC);
  const plumb=await cfQ('?industry=local&seo=1&geo=1&ads=1&stay=1');
  t('channel fit: local service (plumber) → ADS FIRST, payback under 6 months, ROAS > 4x', plumb.mode==='ads-first' && plumb.pb<=6 && plumb.roas>4, JSON.stringify({mode:plumb.mode,pb:plumb.pb,roas:plumb.roas}));
  const saas=await cfQ('?industry=b2b&cpc=45&convrate=0.4&yearly=6000&seo=1&geo=1&ads=1&stay=1');
  t('channel fit: SaaS with $45 clicks at 0.4% → SEO/GEO FIRST, ads inviable, $0 budget', saas.mode==='organic-first' && !saas.viable && /PROJECTED REVENUE ROAS — SEO\/GEO ORGANIC/i.test(saas.kicker), JSON.stringify({mode:saas.mode,adCAC:saas.adCAC,allow:saas.allow,kicker:saas.kicker}));
  t('channel fit: SaaS paid clicks convert at 70% of organic', Math.abs(saas.paidConv-0.7)<1e-9, saas.paidConv);
  t('channel fit: the two verticals read differently (ads-first vs organic-first)', plumb.mode!==saas.mode);
  t('channel fit: combined headline shows the COMBINED return with both channels beside it', /COMBINED/i.test(plumb.kicker) && /×$/.test(plumb.roi) && /SEO\/GEO alone .*ads alone/.test(plumb.roiSub), plumb.kicker+' '+plumb.roi+' | '+plumb.roiSub.slice(-160));
  t('return-word law: the combined headline says ROAS (ads in the plan)', /Revenue ROAS/i.test(plumb.kicker), plumb.kicker);
  t('channel fit: combined return = combined value ÷ combined cost (matches the card table)', plumb.comb!=null && Math.abs(parseFloat(plumb.roi)-Math.round(plumb.comb*10)/10)<0.11, plumb.roi+' vs '+plumb.comb);
  t('channel fit: card carries the verdict and the three-column table', /Channel fit/i.test(plumb.card) && /Ads first/.test(plumb.card) && /Cost per new customer/.test(plumb.card) && /Combined/i.test(plumb.card), plumb.card.slice(0,200));
  const spaPdf=await pdfText('?industry=highticket&seo=1&geo=1&ads=1&stay=1');
  t('channel fit: PDF ads math explains the two tests (stated budget vs payback rule)', /payback rule/.test(spaPdf) && /The larger one wins/.test(spaPdf), spaPdf.slice(spaPdf.indexOf('Two tests'),spaPdf.indexOf('Two tests')+200));
  const adsOnly=await cfQ('?industry=local&organic=0&ads=1&stay=1');
  t('channel fit: ads-only quote headlines the ads ROAS', /ROAS — GOOGLE \+ META ADS ONLY/i.test(adsOnly.kicker) && /×$/.test(adsOnly.roi) && adsOnly.mode==='ads-only', adsOnly.kicker+' '+adsOnly.roi);
  const blk=await cfQ('?industry=highticket&footprint=metro&cpc=4&volume=5000&capacity=2&yearly=50000&convrate=0.1&margin=50&commission=0&years=1&seo=1&geo=1&ads=1&stay=1');
  t('channel fit: one-time sale uses the half-profit rule (Blake: $12,500 payback allowance vs $7,500 stated)', Math.abs(blk.allow-12500)<1 && blk.basis==='payback', JSON.stringify({allow:blk.allow,basis:blk.basis}));

  /* REALISM GUARDS (Payton, Oct 6 — the McEwen audit: right math, wrong inputs) */
  const rgQ=async(qs)=>{ await page.goto(url+qs,{waitUntil:'load'}); return page.evaluate(()=>({conv:document.getElementById('note-conv').innerText.replace(/\s+/g,' '), vol:document.getElementById('note-vol').innerText.replace(/\s+/g,' '), pace:computeQuote(readState()).newCust, xg:(function(){const g=document.getElementById('export-guard'); return g.hidden?'':g.innerText.replace(/\s+/g,' ');})()})); };
  const mc=await rgQ('?client=McEwen&phrase=realtor+Lehi+Utah&industry=highticket&footprint=local&volume=5000&convrate=1.5&yearly=15000&years=1&seo=1&geo=1&stay=1');
  t('realism: agent phrase at 1.5% conversion gets the 0.1–0.25% standard check', /Realism check/.test(mc.conv) && /0\.1–0\.25%/.test(mc.conv) && /at the 0\.25% standard it models/.test(mc.conv), mc.conv.slice(0,160));
  t('realism: 5,000/mo for one city\'s agent-hiring phrase gets the listing-browse intent check', /Intent check/.test(mc.vol) && /low hundreds/.test(mc.vol), mc.vol.slice(0,160));
  t('realism: an open check is repeated next to the PDF buttons, naming both inputs', /Open realism check/.test(mc.xg) && /Search volume and Conversion rate/.test(mc.xg) && /exactly as entered/.test(mc.xg), mc.xg);
  const FLAG=/Realism check|Intent check|Pairing check|\u26a0/;
  const mcOk=await rgQ('?client=McEwen&phrase=realtor+Lehi+Utah&industry=highticket&footprint=local&volume=5000&convrate=0.25&yearly=15000&years=1&seo=1&geo=1&stay=1');
  t('realism: corrected McEwen inputs (whole cluster 5,000/mo at 0.25% — pairing A) raise no warning, only the sizing note', !FLAG.test(mcOk.conv+mcOk.vol) && /Sizing note/.test(mcOk.vol) && /correctly paired/.test(mcOk.vol), (mcOk.conv+mcOk.vol).slice(0,200));
  t('realism: corrected McEwen reproduces the audit document (5,000 × 0.25% → ~1.1 closings/mo)', mcOk.pace>1.0 && mcOk.pace<1.25, String(mcOk.pace));
  const mcDD=await rgQ('?client=McEwen&phrase=realtor+Lehi+Utah&industry=highticket&footprint=local&volume=400&convrate=0.25&yearly=15000&years=1&seo=1&geo=1&stay=1');
  t('realism: the agent-hiring cluster alone (400/mo) at 0.25% is called out as a double discount (pairing B wants 1–1.5%)', /Pairing check/.test(mcDD.conv) && /1–1.5%/.test(mcDD.conv) && /at 1% it models/.test(mcDD.conv) && !/Realism check|Intent check/.test(mcDD.conv+mcDD.vol), mcDD.conv.slice(0,200));
  t('realism: export guard names only the flagged input (conversion rate for the double discount)', /Open realism check on Conversion rate —/.test(mcDD.xg), mcDD.xg);
  const mcDDok=await rgQ('?client=McEwen&phrase=realtor+Lehi+Utah&industry=highticket&footprint=local&volume=400&convrate=1.2&yearly=15000&years=1&seo=1&geo=1&stay=1');
  t('realism: the agent-hiring cluster alone (400/mo) at 1.2% — pairing B — raises nothing', !FLAG.test(mcDDok.conv+mcDDok.vol), (mcDDok.conv+mcDDok.vol).slice(0,200));
  const br=await rgQ('?phrase=homes+for+sale+Lehi+Utah&industry=highticket&footprint=local&volume=5000&convrate=0.25&yearly=15000&years=1&seo=1&geo=1&stay=1');
  t('realism: a listing-browse money phrase is called out as the wrong phrase', /listing-browse phrase/.test(br.vol), br.vol.slice(0,160));
  const bkR=await rgQ('?phrase=park+city+real+estate+agent&industry=highticket&footprint=metro&units=1&volume=5000&cpc=4&capacity=2&yearly=50000&years=1&convrate=0.1&margin=50&commission=0&seo=1&geo=1&markets=Park+City%7E2500%7CHeber+City%7E1200%7CMidway%7E450%7CKamas%7E250%7CHideout%7E350%7CSurrounding%7E250&stay=1');
  t('realism: Blake (5,000 across six resort towns, 0.1% luxury) raises no warning — the band between the two cluster sizes stays silent', !FLAG.test(bkR.conv+bkR.vol), (bkR.conv+bkR.vol).slice(0,200));
  t('realism: export guard stays hidden when nothing is flagged (Blake)', bkR.xg==='', bkR.xg);
  const bkBad=await rgQ('?phrase=park+city+real+estate+agent&industry=highticket&footprint=metro&units=1&volume=5000&cpc=4&capacity=2&yearly=50000&years=1&convrate=1.5&margin=50&commission=0&seo=1&geo=1&markets=Park+City%7E2500%7CHeber+City%7E1200%7CMidway%7E450%7CKamas%7E250%7CHideout%7E350%7CSurrounding%7E250&stay=1');
  t('realism: Blake\'s footprint at a 1.5% med-spa rate IS flagged — 5,000 in total across a footprint is cluster-sized', /Realism check/.test(bkBad.conv) && /Intent check/.test(bkBad.vol), (bkBad.conv+bkBad.vol).slice(0,200));
  const spaR=await rgQ('?phrase=med+spa+provo&industry=highticket&volume=8000&convrate=2.5&yearly=2500&seo=1&geo=1&stay=1');
  t('realism: a med spa at 2.5% is not flagged (repeat-purchase, mid ticket)', !FLAG.test(spaR.conv+spaR.vol));
  const bld=await rgQ('?industry=ultra&yearly=400000&years=1&convrate=1.5&seo=1&geo=1&stay=1');
  t('realism: a $400k one-time project at 1.5% gets the big-ticket check', /Realism check/.test(bld.conv) && /\$25k\+, no repeat/.test(bld.conv) && /0\.1–0\.25%/.test(bld.conv), bld.conv.slice(0,160));
  /* the research prompt carries the McEwen rule: capture it by stubbing window.open + clipboard */
  await page.goto(url+'?industry=highticket&stay=1',{waitUntil:'load'});
  const pr=await page.evaluate(()=>new Promise(res=>{ let got='';
    window.open=function(u){ got=decodeURIComponent(String(u).split('q=')[1]||''); return null; };
    Object.defineProperty(navigator,'clipboard',{value:{writeText:t=>{ got=got||t; return Promise.resolve(); }},configurable:true});
    document.getElementById('website').value='https://example.com'; researchWithAI(); setTimeout(()=>res(got),600); }));
  t('realism: research prompt carries the real-estate phrase/volume/conversion rule', /REAL-ESTATE AGENTS \(the McEwen rule\)/.test(pr) && /low hundreds/.test(pr) && /convrate 0\.25 \(0\.1 luxury-only\)/.test(pr) && /never mixed/.test(pr) && /Default to \(A\)/.test(pr), pr.slice(-400));
  t('realism: research prompt tells the audit to run logged-out and to query the principal\'s name too', /logged-out \/ incognito/.test(pr) && /principal\'s personal name/.test(pr) && /MAP PACK/.test(pr));

  /* ads off (control): no blue segments, organic legend restored */
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const noAds=await page.evaluate(()=>({svg:document.getElementById('o-chart').innerHTML,
    legAds:document.getElementById('legend-ads').hidden, legCost:document.getElementById('legend-cost').textContent}));
  t('chart control: no ads segments when ads off', !/bar-ads/.test(noAds.svg));
  t('chart control: ads legend hidden, cost key restored', noAds.legAds===true && /fixed \+ share/.test(noAds.legCost), noAds.legCost);

  /* THE AUDIT THEME (Payton, Oct 6): Letter, Inter embedded, named page references, PAGE N footers,
     and the return-word law on the tiles */
  const thA=await pdfText('?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&stay=1');
  const thAm=_pdfMeta['?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&stay=1'];
  t('theme: the deck is US Letter', /612 x 792/.test(thAm.size), thAm.size);
  t('theme: Inter is embedded (all four weights)', thAm.inter>=4, String(thAm.inter));
  t('theme: footers carry NEW REWARD · PAGE N · tagline', /N ?E ?W +R ?E ?W ?A ?R ?D/.test(thA) && /PAGE 2/.test(thA) && /Get Found\. Get Trusted\. Get Chosen\./.test(thA));
  t('theme: body copy names pages instead of numbering them', !/on page \d/.test(thA) && /Inputs & Sources page/.test(thA), (thA.match(/on page \d[^.]{0,60}/)||[''])[0]);
  t('return-word law: organic-only deck says REVENUE ROI on the tiles, never ROAS', /ONGOING REVENUE ROI/.test(thA) && /YEAR-1 REVENUE ROI/.test(thA) && !/REVENUE ROAS/.test(thA), (thA.match(/REVENUE RO\w+/g)||[]).join('|'));
  t('return-word law: glossary explains ROI vs ROAS', /Revenue ROI vs revenue ROAS/.test(thA));
  const thB=shrPdf;
  t('return-word law: deck with ads says REVENUE ROAS on the tiles', /ONGOING REVENUE ROAS/.test(thB) && /YEAR-1 REVENUE ROAS/.test(thB), (thB.match(/REVENUE RO\w+/g)||[]).join('|'));
  t('theme: the ads deck carries the plain-words ads math (moved off the site)', /The Ads Math, in Plain Words/.test(thB) && /How the monthly budget is built/.test(thB) && /who gets paid what/.test(thB));
  t('lean site: no section-05 share-math or section-06 ads-math prose on the page', await page.evaluate(()=>!document.getElementById('share-math') && !document.getElementById('ads-math') && !/Full Transparency/.test(document.body.innerText)));

  /* PDF fit-to-page flow (Sept 8 audit): the how-to-read (p3) and honest-answer (p2) sections
     must keep every paragraph AND land above the footer/footnote — no dropped copy, font ≥ 7.8 */
  for(const [nm,qs] of [
    ['blake real', '?industry=highticket&footprint=metro&compstr=strong&volume=5000&cpc=4&capacity=2&yearly=50000&convrate=0.1&margin=50&acq=15&commission=0&seo=1&geo=1&ads=1&stay=1'],
    ['ht commission share 3yr', '?industry=highticket&footprint=multi&volume=6000&cpc=9&convrate=1.2&yearly=30000&years=3&capacity=6&commission=12&seo=1&geo=1&ads=1&stay=1'],
    ['local national big funnel', '?industry=local&footprint=national&volume=80000&cpc=3&commission=6&seo=1&geo=1&ads=1&stay=1'],
    ['no ads share', '?industry=highticket&yearly=12000&commission=10&seo=1&geo=1&stay=1'],
  ]){
    await page.goto(url+qs,{waitUntil:'load'});
    await page.addScriptTag({path:'node_modules/jspdf/dist/jspdf.umd.min.js'});
    const log=await page.evaluate(()=>new Promise(res=>{ window.__pdLog=[];
      const ro=window.openPdfPreview; window.openPdfPreview=function(){ window.openPdfPreview=ro; res(window.__pdLog); };
      try{ buildPDF('preview'); }catch(e){ res([{err:e.message}]); } }));
    t('pdf flow ['+nm+']: builds and logs at least one fitted section', log.length>0 && !log[0].err, JSON.stringify(log).slice(0,200));
    t('pdf flow ['+nm+']: no paragraph dropped', log.every(x=>x.dropped&&x.dropped.length===0), JSON.stringify(log.map(x=>x.dropped)));
    t('pdf flow ['+nm+']: font never below 7.8pt', log.every(x=>x.fs>=7.8), JSON.stringify(log.map(x=>x.fs)));
  }

  await browser.close();
}

/* ---------- main ---------- */
(async function(){
  edgeTests();
  const live=process.argv.includes('--live');
  if(live){
    const idx=process.argv.indexOf('--live');
    const htmlPath=process.argv[idx+1]&&!process.argv[idx+1].startsWith('-')? process.argv[idx+1] : 'index.html';
    await liveTests(htmlPath);
  }
  console.log('\n'+PASS+' passed, '+FAIL+' failed'+(live?'':'  (run with --live for the in-browser cross-check)'));
  process.exit(FAIL?1:0);
})();
