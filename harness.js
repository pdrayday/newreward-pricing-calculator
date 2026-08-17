#!/usr/bin/env node
/* ============================================================================
   NewReward pricing calculator — ADS FEATURE HARNESS (build NR-20260812-53+)

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
  const cpc=q.cpcEff||0, close=q.closeRate;
  const adCAC=(cpc>0&&close>0)? cpc/close : null;                 // cost to win one customer with ads
  const acqAllowed=(acqPct!=null?acqPct:15)/100*q.yearlyValue;    // what the client says a customer may cost
  const adsViable=adCAC!=null && adCAC<=acqAllowed;
  const veryEfficient=adCAC!=null && adCAC<=0.5*acqAllowed;
  const clickCeil=0.5*q.vol*cpc;                                  // never buy more than half the market's clicks
  let budgetAuto=0;
  if(adsViable){
    let b=Math.max(500, Math.max(0,q.capStretch-q.newCust)*adCAC); // fill remaining capacity; $500 soft floor
    b=Math.min(b, clickCeil);                                      // hard ceiling
    b=Math.round(b/250)*250;                                       // $250 snap
    if(b>clickCeil) b-=250;                                        // snap never breaches the ceiling
    budgetAuto=Math.max(0,b);
  }
  const budget=budgetIn!=null? Math.max(0,budgetIn) : budgetAuto;
  const adFull=(cpc>0&&budget>0)? Math.min(budget/cpc*close, q.capStretch) : 0;   // floor-style model
  const roiAds=(budget+fee(budget))>0 ? adFull*q.yearlyValue/(budget+fee(budget)) : null;
  const organicOn=q.nScopes>0;
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
  const mgnPct=q.margin;
  const grossMo=adFull*q.yearlyValue*(mgnPct||0)/100;
  const netMo=grossMo-(budget+fee(budget));
  return {adCAC, acqAllowed, adsViable, veryEfficient, budgetAuto, budget, fee:fee(budget),
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

  // -- viability: highticket defaults (cpc12/conv1.5%) -> CAC $800 vs 15% x $3,000 = $450 -> INVIABLE
  let a=independent(base,15,null);
  t('inviable vertical: adCAC computed', near(a.adCAC,800));
  t('inviable vertical: not viable', !a.adsViable);
  t('inviable vertical: auto budget is $0', a.budgetAuto===0);
  t('inviable vertical: fee $0 at $0 budget', a.fee===0);

  // -- viable vertical: local defaults (cpc6/conv3.5%, $1,200/yr, acq15) -> CAC ~171 vs 180
  const loc={...base, cpcEff:6, closeRate:0.035, yearlyValue:1200, capStretch:75, newCust:20, vol:1100};
  a=independent(loc,15,null);
  t('viable vertical: adCAC ~171', near(a.adCAC,6/0.035,0.01));
  t('viable vertical: viable', a.adsViable);
  t('viable vertical: not very-efficient (CAC > half allowed)', !a.veryEfficient);
  t('viable: auto respects click ceiling (0.5 x 1100 x $6 = $3,300)', a.budgetAuto<=a.clickCeil, a.budgetAuto+' vs ceil '+a.clickCeil);
  t('viable: auto is $250-snapped', a.budgetAuto%250===0, a.budgetAuto);

  // -- very efficient: ultra (cpc9/conv0.25% -> CAC 3600 vs 10% x 250k = 25k)
  const ult={...base, cpcEff:9, closeRate:0.0025, yearlyValue:250000, capStretch:0.77, newCust:0.3,
             vol:400, capApplied:false, contractStyle:true, rampMonth:5, rampSpan:4};
  a=independent(ult,10,null);
  t('ultra: very efficient', a.veryEfficient);
  t('ultra: scale mode (very efficient + demand headroom) -> no taper', a.scaleMode && a.taperStart==null);
  t('ultra: budget floor $500 applies (0.47 slots x $3,600 = $1,692 -> snap)', a.budgetAuto>=500 && a.budgetAuto%250===0, a.budgetAuto);

  // -- budget floor: remaining capacity ~0 -> $500 soft floor (capacity-bound business)
  const capB={...loc, capApplied:true, newCust:75, capStretch:75};   // organic fills capacity at pace
  a=independent(capB,15,null);
  t('budget floor: capacity filled -> auto lands on the $500 floor', a.budgetAuto===500, a.budgetAuto);

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
}

/* ---------- live cross-check against the real calculator ---------- */
async function liveTests(htmlPath){
  const {chromium}=require('playwright');
  const path=require('path');
  const url='file://'+path.resolve(htmlPath);
  const fs=require('fs');
  const exe=['/opt/pw-browsers/chromium','/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
    .find(p=>{try{return fs.existsSync(p)&&fs.statSync(p).isFile();}catch(e){return false;}});
  const browser=await chromium.launch(exe?{executablePath:exe}:{});
  const page=await browser.newPage();
  console.log('\n== live cross-check: '+htmlPath+' ==');

  const CASES=[
    {name:'highticket defaults (inviable)', qs:'?industry=highticket&seo=1&geo=1&ads=1'},
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
                    leadclose:BENCH(s).leadclose??null, margin:(s.margin??BENCH(s).margin)},
              acq:s.acq, dirty:adBudgetDirty,
              budgetField:(document.getElementById('adbudget').value||'').replace(/[^0-9.]/g,'')};
    });
    const exp=independent(got.q, got.acq, got.dirty? parseFloat(got.budgetField)||0 : null);
    const same=(k,eps)=>{
      const va=got.a[k], vb=exp[k];
      const ok=(va==null&&vb==null)||(typeof va==='number'&&typeof vb==='number'? near(va,vb,eps||1e-6) : va===vb);
      t(c.name+': '+k+' matches', ok, JSON.stringify(va)+' vs '+JSON.stringify(vb));
    };
    ['adCAC','acqAllowed','adsViable','veryEfficient','budgetAuto','budget','fee','adFull','floorB','taperStart','taperDone','adsWinsYr','adsCostYr','adsWinsYrInt','lagM','leadClose','clicksMo','leadsMo','cpl','grossMo','netMo'].forEach(k=>same(k,0.01));
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
  t('toggle off: ads-math section hidden', offUi.sec===true);

  /* flat-retainer mode: no rev-share talk anywhere on the ads surfaces */
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&ads=1&revshare=0&stay=1',{waitUntil:'load'});
  const flat=await page.evaluate(()=>({
    card:document.getElementById('ads-card').textContent,
    math:document.getElementById('ads-math').textContent,
    sum:document.getElementById('o-summary').textContent,
    sec:document.getElementById('sec-ads').hidden,
    priceSub:document.getElementById('o-price-sub').textContent}));
  const noShare=s=>!/rev[- ]?share|revenue share|share-free|% share|of share|share starts|share begins|no share|the share /i.test(s);
  t('flat mode: ads-math section visible', flat.sec===false);
  t('flat mode: no rev-share talk on the ads card', noShare(flat.card), flat.card.slice(0,200));
  t('flat mode: no rev-share talk in section 06', noShare(flat.math));
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
  const shr=await page.evaluate(()=>({math:document.getElementById('ads-math').textContent,
    inSec:!!document.querySelector('#sec-ads #adbudget')}));
  t('share mode: section 06 states the rev-share exclusion', /never rev-share billed/.test(shr.math));
  t('share mode: section 06 explains CAC and guardrails', /simple|clicks become customers/i.test(shr.math) && /guardrail/i.test(shr.math));
  t('budget input lives inside section 06', shr.inSec===true);

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
  t('stack: card shows the combined all-in month-1 price', stk.card.indexOf(money(stk.allIn))>=0, money(stk.allIn));
  t('stack: card lists both prices separately', stk.card.indexOf(money(stk.price))>=0 && stk.card.indexOf(money(stk.budget))>=0);
  t('stack: card shows the combined year-one line', /Year one, combined/.test(stk.card));
  t('separation: ROI sub says organic-alone when ads are on', /organic SEO\/GEO program alone/.test(stk.roiSub));
  t('chart: timeline explains the blue ads segments', /blue segments are ads-won/i.test(stk.tl));
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
  t('labels: ROI kicker says SEO/GEO organic', /SEO\/GEO organic/.test(lbl.kick), lbl.kick);
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
  t('labels control (ads off): kicker plain', lblOff.kick==='Projected ROI', lblOff.kick);
  t('labels control (ads off): price label plain', lblOff.price==='Fixed monthly investment');
  t('labels control (ads off): projection label plain', lblOff.proj==='12-Month Projection');
  t('labels control (ads off): pace-cards kicker hidden + flat note empty', lblOff.ocHidden===true && lblOff.fan==='');

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
            math:document.getElementById('ads-math').innerText.replace(/\s+/g,' '),
            lag:a.lagM, m12:a.months.map(x=>x.adsW).join(',')};
  });
  t('lag UI: big-ticket quote lags 2 months', lagUi.lag===2);
  t('lag UI: card no longer claims "month 1, no ramp"', !/month 1, no ramp/i.test(lagUi.card), lagUi.card.slice(0,260));
  t('lag UI: card says first closings land ~month 3', /closings land (~|around )?month 3/i.test(lagUi.card), lagUi.card.slice(0,400));
  t('lag UI: section 06 carries the honest timing note', /timing note/i.test(lagUi.math) && /month 3/.test(lagUi.math));
  t('lag UI: schedule wins months 1-2 are zero', lagUi.m12.split(',').slice(0,2).join(',')==='0,0', lagUi.m12);
  /* fast vertical control: local keeps its month-1 delivery claim */
  await page.goto(url+'?industry=local&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const lagC=await page.evaluate(()=>{
    const s=readState(), q=computeQuote(s), n=getNegotiated(q), a=adsState(s,q,n.rampMonth);
    return {lag:a.lagM, card:document.getElementById('ads-card').innerText.replace(/\s+/g,' ')};
  });
  t('lag control: local service lags 0 and keeps "from month 1, no ramp"', lagC.lag===0 && /from month 1, no ramp/i.test(lagC.card), lagC.card.slice(0,240));

  /* THE FUNNEL on the surfaces (HOTH-referenced, Aug 17) */
  await page.goto(url+'?industry=local&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const fun1=await page.evaluate(()=>({card:document.getElementById('ads-card').innerText.replace(/\s+/g,' '),
    math:document.getElementById('ads-math').innerText.replace(/\s+/g,' ')}));
  t('funnel: card shows clicks → leads → customers', /The funnel: [\d,]+ clicks → ~\d+ leads \(\$[\d,]+\/lead\) → /.test(fun1.card), fun1.card.slice(0,300));
  t('funnel: card shows the net-after-margin line', /\/mo net after the client|break-even/.test(fun1.card));
  t('funnel: section 06 walks the funnel with leads and CPL', /become leads/.test(fun1.math) && /per lead/.test(fun1.math));
  t('funnel: section 06 has the profit-terms line', /in profit terms/i.test(fun1.math));
  await page.goto(url+'?industry=ecom&seo=1&geo=1&ads=1&stay=1',{waitUntil:'load'});
  const fun2=await page.evaluate(()=>({card:document.getElementById('ads-card').innerText.replace(/\s+/g,' '),
    math:document.getElementById('ads-math').innerText.replace(/\s+/g,' ')}));
  t('funnel (ecom): no lead stage on the card', !/leads \(/.test(fun2.card), fun2.card.slice(0,260));
  t('funnel (ecom): section 06 says buyers purchase directly', /purchase directly|no lead stage/i.test(fun2.math));

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

  /* ads off (control): no blue segments, organic legend restored */
  await page.goto(url+'?industry=highticket&volume=8000&cpc=8&convrate=2.5&yearly=2500&capacity=20&seo=1&geo=1&stay=1',{waitUntil:'load'});
  const noAds=await page.evaluate(()=>({svg:document.getElementById('o-chart').innerHTML,
    legAds:document.getElementById('legend-ads').hidden, legCost:document.getElementById('legend-cost').textContent}));
  t('chart control: no ads segments when ads off', !/bar-ads/.test(noAds.svg));
  t('chart control: ads legend hidden, cost key restored', noAds.legAds===true && /fixed \+ share/.test(noAds.legCost), noAds.legCost);

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
