
/* AMC Lincoln Square IMAX 70mm Dune: Part Three seat watcher */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const nodemailer = require('nodemailer');
puppeteer.use(StealthPlugin());

const MOVIES = ['dune: part three', 'dune part three'];
const THEATER_URL = 'https://www.amctheatres.com/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes';
const TEST_MODE = ['true','1'].includes((process.env.TEST_MODE || '').toLowerCase());
const TARGET_ROWS = TEST_MODE ? ['A','B','C','D','E','F','G','H','J','K','L','M','N','P'] : ['F','G','H','J'];
const TARGET_COL_MIN = TEST_MODE ? 1 : 9;
const TARGET_COL_MAX = TEST_MODE ? 100 : 39;
const EXCLUDED_START = '2026-12-19';
const EXCLUDED_END = '2027-01-03';
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAIL || '').split(',').map(x=>x.trim()).filter(Boolean);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);

function adjacentPairs(seats) {
  const groups = new Map();
  for (const seat of seats) {
    const m = /^([A-Z]+)(\d+)$/.exec(seat);
    if (!m) continue;
    const row = m[1], col = Number(m[2]);
    if (!groups.has(row)) groups.set(row, new Set());
    groups.get(row).add(col);
  }
  const pairs = [];
  for (const [row, cols] of groups) {
    for (const col of [...cols].sort((a,b)=>a-b)) {
      if (cols.has(col+1)) pairs.push([`${row}${col}`, `${row}${col+1}`]);
    }
  }
  return pairs;
}

async function sendEmail(subject, html) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !NOTIFY_EMAILS.length) {
    log('Email credentials missing; notification not sent.');
    return false;
  }
  const transporter = nodemailer.createTransport({service:'gmail', auth:{user:GMAIL_USER,pass:GMAIL_APP_PASSWORD}});
  await transporter.sendMail({from:`"AMC Watcher" <${GMAIL_USER}>`,to:NOTIFY_EMAILS,subject,html});
  return true;
}

async function getAvailableDates(page) {
  await page.goto(THEATER_URL,{waitUntil:'networkidle2',timeout:60000});
  await sleep(2000);
  return page.evaluate(() => [...document.querySelectorAll('select[name="date"] option')]
    .map(o=>o.value).filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v)));
}

async function getShowtimes(page,date) {
  await page.goto(`${THEATER_URL}?date=${date}`,{waitUntil:'networkidle2',timeout:60000});
  await sleep(2000);
  return page.evaluate(movieTerms => {
    const results=[];
    for (const link of document.querySelectorAll("a[href*='/showtimes/']")) {
      const match=link.href.match(/\/showtimes\/(\d+)/);
      if (!match) continue;
      const formatLi=link.closest('ul')?.closest('li');
      if (!(formatLi?.innerText || '').toUpperCase().includes('IMAX 70MM')) continue;
      const movieName=link.closest('section')?.querySelector('h1')?.innerText?.trim() || '';
      if (!movieTerms.some(term=>movieName.toLowerCase().includes(term))) continue;
      results.push({id:match[1],movie:movieName,time:link.innerText.trim().split('\n')[0],soldOut:link.innerText.includes('Sold Out')});
    }
    return results;
  },MOVIES);
}

async function getAvailableSeats(page,showtimeId) {
  await page.goto(`https://www.amctheatres.com/showtimes/${showtimeId}`,{waitUntil:'networkidle2',timeout:60000});
  await sleep(3000);
  return page.evaluate((rows,min,max)=>{
    const available=[];
    for (const input of document.querySelectorAll('input[aria-label]')) {
      const label=input.getAttribute('aria-label') || '';
      // Conservative filter: reject disabled and explicitly unavailable seats.
      if (input.disabled || input.getAttribute('aria-disabled') === 'true' || /occupied|unavailable|reserved|blocked|wheelchair|companion/i.test(label)) continue;
      const match=label.match(/([A-Z])(\d+)$/);
      if (!match) continue;
      const row=match[1],col=Number(match[2]);
      if (rows.includes(row) && col>=min && col<=max) available.push(`${row}${col}`);
    }
    return available;
  },TARGET_ROWS,TARGET_COL_MIN,TARGET_COL_MAX);
}

async function main() {
  const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox']});
  const page=await browser.newPage();
  try {
    const allDates=[...new Set(await getAvailableDates(page))].sort();
    const dates=allDates.filter(date=>date<EXCLUDED_START || date>EXCLUDED_END);
    log(`Found ${allDates.length} dates; scanning ${dates.length} outside travel blackout.`);
    for (const date of dates) {
      let showtimes;
      try { showtimes=await getShowtimes(page,date); }
      catch(err) { log(`Could not load ${date}: ${err.message}`); continue; }
      for (const st of showtimes) {
        if (st.soldOut) continue;
        try {
          const seats=await getAvailableSeats(page,st.id);
          const pairs=adjacentPairs(seats);
          if (!pairs.length) { log(`${date} ${st.time}: no adjacent pair in target zone`); continue; }
          const pairsText=pairs.map(p=>p.join(' + ')).join(', ');
          log(`${date} ${st.time}: ${pairsText}`);
          const url=`https://www.amctheatres.com/showtimes/${st.id}`;
          const html=`<h2>Dune: Part Three — IMAX 70mm</h2><p>${date} ${st.time}</p><p>Adjacent pairs in target zone: ${pairsText}</p><p><a href="${url}">Check seats and book</a></p><p>Seat availability may change before checkout. Confirm on AMC's seat map.</p>`;
          if (await sendEmail(`Dune IMAX 70mm: adjacent seats — ${date} ${st.time}`,html)) log('Email sent.');
        } catch(err) { log(`Error checking ${st.id}: ${err.message}`); }
        await sleep(1000);
      }
    }
  } finally { await browser.close(); }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
