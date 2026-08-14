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
  const months=[]; let adsWinsYr=0, adsCostYr=0;
  for(let m=1;m<=12;m++){
    let bm=budget;
    if(taperStart!=null&&m>=taperStart){
      const k=Math.min(1,(m-taperStart+1)/3);
      bm=budget-(budget-floorB)*k;
      bm=Math.max(floorB, Math.round(bm/250)*250);
    }
    const org=organicOn? q.newCust*fW(m):0;
    const adm=(cpc>0&&bm>0)? Math.min(bm/cpc*close, Math.max(0,q.capStretch-org)) : 0;
    months.push({m, budget:bm, fee:fee(bm), ads:adm, organic:org, total:org+adm});
    adsWinsYr+=adm; adsCostYr+=bm+fee(bm);
  }
  return {adCAC, acqAllowed, adsViable, veryEfficient, budgetAuto, budget, fee:fee(budget),
          adFull, roiAds, clickCeil, floorB, demandLimited, scaleMode, taperStart,
          taperDone:taperStart!=null?Math.min(12,taperStart+2):null, rampFull, organicOn, months,
          adsWinsYr, adsCostYr};
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
  ];
  for(const c of CASES){
    await page.goto(url+c.qs+'&stay=1',{waitUntil:'load'});
    const got=await page.evaluate(()=>{
      const s=readState(), q=computeQuote(s), n=getNegotiated(q);
      const a=adsState(s,q,n.rampMonth);
      return {a, q:{cpcEff:q.cpcEff, closeRate:q.closeRate, yearlyValue:q.yearlyValue,
                    capStretch:q.capStretch, newCust:q.newCust, vol:q.vol, capApplied:q.capApplied,
                    nScopes:q.nScopes, rampMonth:n.rampMonth, rampSpan:q.rampSpan,
                    contractStyle:q.contractStyle},
              acq:s.acq, dirty:adBudgetDirty,
              budgetField:(document.getElementById('adbudget').value||'').replace(/[^0-9.]/g,'')};
    });
    const exp=independent(got.q, got.acq, got.dirty? parseFloat(got.budgetField)||0 : null);
    const same=(k,eps)=>{
      const va=got.a[k], vb=exp[k];
      const ok=(va==null&&vb==null)||(typeof va==='number'&&typeof vb==='number'? near(va,vb,eps||1e-6) : va===vb);
      t(c.name+': '+k+' matches', ok, JSON.stringify(va)+' vs '+JSON.stringify(vb));
    };
    ['adCAC','acqAllowed','adsViable','veryEfficient','budgetAuto','budget','fee','adFull','floorB','taperStart','taperDone','adsWinsYr','adsCostYr'].forEach(k=>same(k,0.01));
    const mOk=got.a.months.every((mo,i)=>near(mo.budget,exp.months[i].budget,0.01)&&near(mo.fee,exp.months[i].fee,0.01)
              &&near(mo.ads,exp.months[i].ads,1e-4)&&near(mo.organic,exp.months[i].organic,1e-4));
    t(c.name+': 12-month schedule matches', mOk);
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
