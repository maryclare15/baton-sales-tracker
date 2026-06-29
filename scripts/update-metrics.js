#!/usr/bin/env node
/**
 * Fetches live metrics from Hex Sales Performance Dashboard and updates data.json.
 * Run by GitHub Action on schedule, or manually: node scripts/update-metrics.js
 * Requires env var: HEX_API_TOKEN
 */

const fs   = require('fs');
const path = require('path');

const TOKEN      = process.env.HEX_API_TOKEN;
const PROJECT_ID = '019f04a8-0271-775e-84c3-6fe28e209c51';
const DATA_PATH  = path.join(__dirname, '../data.json');
const HEX_BASE   = 'https://app.hex.tech/api/v1';

if (!TOKEN) { console.error('HEX_API_TOKEN not set'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function createThread(prompt) {
  const res = await fetch(`${HEX_BASE}/ai/thread`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT_ID, userMessage: prompt })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Create thread ${res.status}: ${body.slice(0,300)}`);
  }
  return res.json();
}

async function pollThread(threadId, maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(5000);
    const res = await fetch(`${HEX_BASE}/ai/thread/${threadId}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
    if (!res.ok) { console.log(`Poll ${res.status}, retrying...`); continue; }
    const data = await res.json();
    const status = (data.status || data.threadStatus || '').toUpperCase();
    console.log(`  status: ${status}`);
    if (['IDLE','COMPLETE','COMPLETED','DONE','FINISHED'].includes(status)) return data;
    if (['ERROR','ERRORED','FAILED','CANCELLED'].includes(status)) throw new Error(`Thread failed: ${status}`);
  }
  throw new Error('Thread polling timed out after 2 minutes');
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON block found in response:\n' + text.slice(0, 500));
  return JSON.parse(match[0]);
}

function getResponseText(threadData) {
  // Handle various Hex API response shapes
  if (typeof threadData.response === 'string') return threadData.response;
  if (typeof threadData.text === 'string')     return threadData.text;
  if (typeof threadData.content === 'string')  return threadData.content;
  const msgs = threadData.messages || threadData.threadMessages || [];
  const last = msgs[msgs.length - 1];
  if (last) return last.content || last.text || JSON.stringify(last);
  return JSON.stringify(threadData);
}

async function main() {
  const prompt = `From the Hex Sales Performance Dashboard (project ${PROJECT_ID}), give me June 2026 actuals only.
Return ONLY a JSON object with no markdown, no explanation, no extra text:
{
  "hfc_tot": <HFC Total count>,
  "hfc_pos": <HFC Positive count>,
  "cf_tot":  <CF Total count>,
  "qual_cf": <Qual CF count>,
  "vr":      <VR Held count>,
  "ssa":     <SSA total count>,
  "live":    <LIVE total count>,
  "icp_cf":   <CF meetings with ICP businesses valued over 1M>,
  "icp_vr":   <VR Held with ICP businesses valued over 1M>,
  "icp_ssa":  <SSAs with ICP businesses valued over 1M>,
  "icp_live": <LIVE listings that are ICP businesses valued over 1M>,
  "inv_signed": <total signed inventory value in dollars>,
  "inv_live":   <total live inventory value in dollars>
}`;

  console.log('Creating Hex thread...');
  const thread = await createThread(prompt);
  const threadId = thread.id || thread.threadId;
  if (!threadId) throw new Error('No thread ID in response: ' + JSON.stringify(thread).slice(0,200));
  console.log(`Thread created: ${threadId}`);

  console.log('Polling for completion...');
  const result = await pollThread(threadId);

  const responseText = getResponseText(result);
  console.log('Response preview:', responseText.slice(0, 400));

  const metrics = extractJson(responseText);
  console.log('Parsed metrics:', JSON.stringify(metrics, null, 2));

  // Load existing to preserve anything not returned
  const existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const prev = f => existing.funnel.find(x => x.key === f)?.actual;
  const prevIcp = l => existing.icp.find(x => x.label === l)?.icp;

  existing.funnel = [
    { key:'hfc_tot', actual: metrics.hfc_tot ?? prev('hfc_tot') },
    { key:'hfc_pos', actual: metrics.hfc_pos ?? prev('hfc_pos') },
    { key:'cf_tot',  actual: metrics.cf_tot  ?? prev('cf_tot')  },
    { key:'qual_cf', actual: metrics.qual_cf ?? prev('qual_cf') },
    { key:'vr',      actual: metrics.vr      ?? prev('vr')      },
    { key:'ssa',     actual: metrics.ssa     ?? prev('ssa')     },
    { key:'live',    actual: metrics.live    ?? prev('live')    },
  ];

  const cfTotal   = metrics.cf_tot  ?? prev('cf_tot');
  const vrTotal   = metrics.vr      ?? prev('vr');
  const ssaTotal  = metrics.ssa     ?? prev('ssa');
  const liveTotal = metrics.live    ?? prev('live');

  existing.icp = [
    { label:'CF',      icp: metrics.icp_cf   ?? prevIcp('CF'),      total: cfTotal   },
    { label:'VR Held', icp: metrics.icp_vr   ?? prevIcp('VR Held'), total: vrTotal   },
    { label:'SSA',     icp: metrics.icp_ssa  ?? prevIcp('SSA'),     total: ssaTotal  },
    { label:'LIVE',    icp: metrics.icp_live ?? prevIcp('LIVE'),    total: liveTotal },
  ];

  if (metrics.inv_signed) existing.inventory.signed = metrics.inv_signed;
  if (metrics.inv_live)   existing.inventory.live   = metrics.inv_live;

  existing.syncedAt = new Date().toISOString();

  fs.writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log('\ndata.json updated successfully.');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
