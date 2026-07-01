#!/usr/bin/env node
// ee-quick-maturity.js - DIRECT Qdrant upsert for bb-packages, bb-recipes,
// experience-behavioral, experience-principles. Bypasses storeExperience()
// which always routes to SELFQA_COLLECTION.
"use strict";
const Q = "http://localhost:6333";
const QK = "sk_live_KpJpFQBFdjp9yrK8YTIVwzh8Mz9wfy96";
const EU = "https://api.siliconflow.com/v1/embeddings";
const EK = "sk-rnqvvxycuvmztbwyenxoictwmhnquaecmulxwalcgoipphsl";
const EM = "Qwen/Qwen3-Embedding-0.6B";
const DIM = 1024;
const crypto = require("crypto");

async function embed(t) {
  const r = await fetch(EU, {method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+EK},
    body:JSON.stringify({model:EM,input:t,encoding_format:"float"}),
    signal:AbortSignal.timeout(20000)});
  if (!r.ok) throw Error("embed "+r.status+": "+(await r.text()).slice(0,200));
  const j = await r.json();
  const v = j?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length !== DIM) throw Error("bad embed len="+(Array.isArray(v)?v.length:"none"));
  return v;
}

async function upsert(col, pts) {
  for (let i=0; i<pts.length; i+=50) {
    const batch = pts.slice(i,i+50);
    const r = await fetch(Q+"/collections/"+col+"/points?wait=true", {method:"PUT",
      headers:{"Content-Type":"application/json","api-key":QK},
      body:JSON.stringify({points:batch}),
      signal:AbortSignal.timeout(60000)});
    if (!r.ok) throw Error("qdrant "+col+"["+i+"]: "+r.status+" "+(await r.text()).slice(0,300));
  }
}

async function main() {
  const t0=Date.now(); let total=0;

  // ====== BB PACKAGES (24) ======
  const pkgs = JSON.parse(require("fs").readFileSync(
    require("path").join(__dirname,"ee-packages-data.json"),"utf8"));
  console.log("Embedding "+pkgs.length+" packages...");
  const pp = [];
  for (const p of pkgs) {
    const txt = "bb-package:"+p.n+" Use "+p.n+" ("+p.t+"): "+p.s;
    const v = await embed(txt);
    pp.push({id:crypto.randomUUID(),vector:v,payload:{
      text:txt,trigger:"bb-package:"+p.n,failureMode:"package:"+p.d,
      solution:p.s,judgment:"structural",
      conditions:["tier:"+p.t,"domain:"+p.d,"collection:bb-packages"],
      sourceSession:"maturity-20260629",createdFrom:"maturity",
      domain:"bb-dotnet:"+p.d,projectSlug:"muonroi-building-block",tier:p.t}});
  }
  await upsert("bb-packages",pp); total+=pp.length;
  console.log("  OK bb-packages: "+pp.length);

  // ====== BB RECIPES (12) ======
  const recipes = JSON.parse(require("fs").readFileSync(
    require("path").join(__dirname,"ee-recipes-data.json"),"utf8"));
  console.log("Embedding "+recipes.length+" recipes...");
  const rp = [];
  for (const r of recipes) {
    const txt = "bb-recipe:"+r.t+": "+r.s;
    const v = await embed(txt);
    rp.push({id:crypto.randomUUID(),vector:v,payload:{
      text:txt,trigger:"bb-recipe:"+r.d,failureMode:"recipe:"+r.d,
      solution:r.t+": "+r.s,judgment:"structural",
      conditions:["domain:"+r.d,"collection:bb-recipes"],
      sourceSession:"maturity-20260629",createdFrom:"maturity",
      domain:"bb-dotnet:"+r.d,projectSlug:"muonroi-building-block"}});
  }
  await upsert("bb-recipes",rp); total+=rp.length;
  console.log("  OK bb-recipes: "+rp.length);

  // ====== BEHAVIORAL (21) ======
  const beh = JSON.parse(require("fs").readFileSync(
    require("path").join(__dirname,"ee-behavioral-data.json"),"utf8"));
  console.log("Embedding "+beh.length+" behavioral...");
  const bp = [];
  for (const b of beh) {
    const txt = "behavioral:"+b.t+": "+b.s;
    const v = await embed(txt);
    bp.push({id:crypto.randomUUID(),vector:v,payload:{
      text:txt,trigger:b.t,failureMode:b.t,solution:b.s,
      judgment:"behavioral",
      conditions:[b.c1,b.c2,"collection:experience-behavioral"],
      sourceSession:"maturity-20260629",createdFrom:"maturity",
      projectSlug:"muonroi-cli"}});
  }
  await upsert("experience-behavioral",bp); total+=bp.length;
  console.log("  OK experience-behavioral: "+bp.length);

  // ====== PRINCIPLES (18) ======
  const prins = JSON.parse(require("fs").readFileSync(
    require("path").join(__dirname,"ee-principles-data.json"),"utf8"));
  console.log("Embedding "+prins.length+" principles...");
  const pip = [];
  for (const p of prins) {
    const txt = "principle:"+p.t+": "+p.s;
    const v = await embed(txt);
    pip.push({id:crypto.randomUUID(),vector:v,payload:{
      text:txt,trigger:p.t,failureMode:p.t,solution:p.s,
      judgment:"principle",
      conditions:["source:seed","scope:universal","collection:experience-principles"],
      sourceSession:"maturity-20260629",createdFrom:"seed"}});
  }
  await upsert("experience-principles",pip); total+=pip.length;
  console.log("  OK experience-principles: "+pip.length);

  console.log("DONE. Total: "+total+" points in "+(Date.now()-t0)+"ms");
}
main().catch(e=>{console.error("FATAL:",e.message);process.exit(1)});
