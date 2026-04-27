export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url  = new URL(request.url);
    const path = url.pathname;
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    });

    // ── Route 1: 經濟部商工 GCIS（公司 + 行號 + 有限合夥）────────────
    if (path.startsWith('/api/gcis/')) {
      const ban = path.replace('/api/gcis/', '').trim();
      if (!/^\d{8}$/.test(ban)) return json({ found: false, error: 'invalid' });
      try {
        const BASE   = 'https://data.gcis.nat.gov.tw/od/data/api';
        const FILTER = `?$format=json&$filter=Business_Accounting_NO%20eq%20${ban}&$skip=0&$top=1`;
        const HDRS   = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
        const APIS   = [
          [`${BASE}/6BBA2268-1367-4B42-9CCA-BC17499EBE8C${FILTER}`, '公司'],
          [`${BASE}/9D17AE0D-37FD-4D41-8592-0D03BDF0F32C${FILTER}`, '行號'],
          [`${BASE}/236EE382-4942-41A9-BD03-CA0709025E7C${FILTER}`, '有限合夥'],
        ];

        for (const [apiUrl, orgType] of APIS) {
          const r = await fetch(apiUrl, { headers: HDRS });
          if (!r.ok) continue;
          const j = await r.json();
          if (!Array.isArray(j) || j.length === 0) continue;
          const raw        = j[0];
          const name       = raw.Company_Name || raw.Business_Name || raw.Partnership_Name || '';
          const statusCode = raw.Company_Status || raw.Business_Status || raw.Partnership_Status || '';
          const statusDesc = raw.Company_Status_Desc || raw.Business_Status_Desc || raw.Partnership_Status_Desc || '';
          const isActive   = statusCode === '01' || statusDesc.includes('核准設立') || statusDesc.includes('設立登記');
          return json({
            found: true, ban, orgType, name,
            status:      statusDesc || (isActive ? '核准設立' : '非正常'),
            statusOk:    isActive,
            responsible: raw.Responsible_Name || raw.Representative_Name || '',
            setupDate:   raw.Company_Setup_Date || raw.Business_Setup_Date || raw.Partnership_Setup_Date || '',
            capital:     String(raw.Capital_Amount || raw.Paid_In_Capital_Amount || ''),
            address:     raw.Company_Location || raw.Business_Address || raw.Company_Address || '',
            bizItems:    raw.Business_Item_Desc || '',
            source:      'data.gcis.nat.gov.tw',
          });
        }
        return json({ found: false });
      } catch (e) {
        return json({ found: false, error: e.message });
      }
    }

    // ── Route 1b: findbiz.nat.gov.tw（GCIS 備援，含工廠/機關）──────────
    if (path.startsWith('/api/findbiz/')) {
      const ban = path.replace('/api/findbiz/', '').trim();
      if (!/^\d{8}$/.test(ban)) return json({ found: false, error: 'invalid' });
      try {
        // 嘗試多個 findbiz 路徑
        const targets = [
          // 依統編直接查詳細（若有 server-side render）
          `https://findbiz.nat.gov.tw/fts/query/QueryBar/queryBanNo.do?banNo=${ban}&isMRC=N&isComp=Y&isBus=Y&isFactory=Y&isLtd=Y&isAll=Y`,
          // QueryList（帶較多篩選條件）
          `https://findbiz.nat.gov.tw/fts/query/QueryList/queryList.do?banNo=${ban}&isMRC=N&isComp=Y&isBus=Y&isFactory=Y&isLtd=Y&isAll=Y`,
        ];
        const hdrs = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-TW,zh;q=0.9',
          'Referer': 'https://findbiz.nat.gov.tw/',
        };
        for (const url of targets) {
          const r = await fetch(url, { headers: hdrs });
          if (!r.ok) continue;
          const html = await r.text();
          const result = parseFindbiz(html, ban);
          if (result.found) return json(result);
        }
        return json({ found: false });
      } catch (e) {
        return json({ found: false, error: e.message });
      }
    }

    // ── Route 2: 財政部稅務網（etax.nat.gov.tw）────────────────────────
    // 涵蓋「非營業中、撤銷、停業」等 9400 API 不收錄的稅籍資料
    if (path.startsWith('/api/etax/')) {
      const ban = path.replace('/api/etax/', '').trim();
      if (!/^\d{8}$/.test(ban)) return json({ found: false });
      try {
        const BASE_HDRS = {
          'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept':         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language':'zh-TW,zh;q=0.9,en-US;q=0.8',
          'Accept-Encoding':'gzip, deflate, br',
        };
        // Step A：先 GET 取得 session cookie（WAF 確認機制）
        let cookie = '';
        try {
          const g = await fetch('https://www.etax.nat.gov.tw/etwmain/etw113w1/ban/query', {
            headers: BASE_HDRS, redirect: 'follow',
          });
          const sc = g.headers.get('set-cookie');
          if (sc) cookie = sc.split(';')[0];
        } catch (_) {}

        const FORM_HDRS = {
          ...BASE_HDRS,
          'Content-Type':  'application/x-www-form-urlencoded',
          'Origin':        'https://www.etax.nat.gov.tw',
          'Referer':       'https://www.etax.nat.gov.tw/etwmain/etw113w1/ban/query',
          ...(cookie ? { 'Cookie': cookie } : {}),
        };
        // Step B：查稅籍基本資料
        const r1 = await fetch(
          'https://www.etax.nat.gov.tw/etwmain/etw113w1/ban/query',
          { method: 'POST', headers: FORM_HDRS, body: `banNo=${ban}`, redirect: 'follow' }
        );
        let result = { found: false, ban, source: 'etax.nat.gov.tw' };
        if (r1.ok) result = parseEtax(await r1.text(), ban);

        // 查免開統一發票（etw113w3）
        try {
          const r2 = await fetch(
            'https://www.etax.nat.gov.tw/etwmain/etw113w3/ban/query',
            {
              method: 'POST',
              headers: { ...FORM_HDRS, Referer: 'https://www.etax.nat.gov.tw/etwmain/etw113w3/ban/query' },
              body: `banNo=${ban}`,
              redirect: 'follow',
            }
          );
          if (r2.ok) {
            const h2 = await r2.text();
            const exempt = h2.includes('免開統一發票') || h2.includes('小規模');
            const noData = h2.includes('查無符合') || h2.includes('查無資料');
            if (exempt)  { result.found = true; result.invoiceFlag = 'N'; }
            else if (!noData && h2.includes(ban)) result.invoiceFlag = 'Y';
          }
        } catch (_) {}

        return json(result);
      } catch (e) {
        return json({ found: false, error: e.message });
      }
    }

    // ── Route 3: Claude AI 代理（含 web_search）──────────────────────
    if (path === '/api/claude' && request.method === 'POST') {
      const KEY = env.ANTHROPIC_API_KEY;
      if (!KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
      try {
        const body = await request.json();
        const r    = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type':    'application/json',
            'x-api-key':       KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta':  'web-search-2025-03-05',
          },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        return new Response(JSON.stringify(data), {
          status:  r.status,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Route 3: twincn.com（補充資料）───────────────────────────────
    if (path.startsWith('/api/twincn/')) {
      const ban = path.replace('/api/twincn/', '').trim();
      if (!/^\d{8}$/.test(ban)) return json({ found: false });
      try {
        const r    = await fetch(`https://www.twincn.com/item.aspx?no=${ban}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', Accept: 'text/html', 'Accept-Language': 'zh-TW' },
        });
        const html = await r.text();
        return json(parseTwincn(html, ban));
      } catch (e) {
        return json({ found: false, error: e.message });
      }
    }

    // ── Route 4: 健康檢查 ────────────────────────────────────────────
    if (path === '/api/test') {
      return json({ ok: true, hasKey: !!env.ANTHROPIC_API_KEY, ts: new Date().toISOString() });
    }

    return new Response('Invoice Checker Worker OK', { headers: cors });
  },
};

function parseEtax(html, ban) {
  if (!html || html.length < 300) return { found: false, ban };
  if (html.includes('查無符合') || html.includes('查無資料') || html.includes('查無相符')) {
    return { found: false, ban };
  }
  // 頁面必須含有此統編，避免抓到公告/錯誤頁
  if (!html.includes(ban)) return { found: false, ban };

  // 嚴格從 <th> 標籤內的 label 開始匹配，避免誤抓公告文字
  function field(...labels) {
    for (const label of labels) {
      const re = new RegExp(
        '<t[dh][^>]*>\\s*' + label + '\\s*</t[dh]>\\s*<td[^>]*>([^<]{1,150})',
        'i'
      );
      const m = html.match(re);
      if (m && m[1].trim()) return m[1].replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  const name        = field('營業人名稱');
  const status      = field('營業狀況', '稅籍狀態');
  const responsible = field('負責人姓名', '負責人');
  // 公司名稱超過 60 字元視為誤抓
  if (name.length > 60) return { found: false, ban };
  if (!name && !status) return { found: false, ban };

  const address   = field('登記地址', '地址', '所在地');
  const capital   = field('資本額');
  const orgType   = field('組織種類', '組織型態');
  const setupDate = field('設立日期');

  // 登記營業項目（<td> 內可能有 <br>）
  const bizM = html.match(/<t[dh][^>]*>\s*登記營業項目\s*<\/t[dh]>\s*<td[^>]*>([\s\S]{1,1500}?)<\/td>/i);
  const bizItems = bizM
    ? bizM[1].replace(/<br\s*\/?>/gi, '、').replace(/<[^>]+>/g, '').replace(/、+/g, '、').trim()
    : '';

  const isActive = status.includes('營業中') && !status.includes('非');

  return {
    found: true, ban, name,
    status:      status || '（查到稅籍資料）',
    statusOk:    isActive,
    responsible, address, capital, orgType, setupDate, bizItems,
    source: 'etax.nat.gov.tw',
  };
}

function parseFindbiz(html, ban) {
  if (!html || html.length < 300) return { found: false, ban };

  // 頁面必須含有此統編，避免抓到公告/錯誤頁
  if (!html.includes(ban)) return { found: false, ban };

  // 排除明確的查無資料頁
  if (html.includes('查無資料') || html.includes('無符合') || html.includes('0 筆')) {
    return { found: false, ban };
  }

  // 公司/商業名稱：抓多種可能的 HTML 結構
  let name = '';
  const namePatterns = [
    // table 欄位（最可靠）
    /(?:公司名稱|商業名稱|名\s*稱)[^<]*<\/th>\s*<td[^>]*>\s*([^<\r\n]{2,60}?)\s*<\/td>/i,
    // data-* 屬性
    /data-company-name="([^"]{2,60})"/i,
    // 清單 heading（限定必須以公司類型結尾，避免抓到公告）
    /<(?:h[2-5])[^>]*>\s*([^<]{2,40}(?:股份有限公司|有限公司|商行|商號|協會|基金會)[^<]{0,10})\s*<\/(?:h[2-5])>/i,
  ];
  for (const p of namePatterns) {
    const m = html.match(p);
    if (m && m[1].trim()) { name = m[1].trim(); break; }
  }

  // 登記狀況
  let status = '', isActive = false;
  if      (html.includes('核准設立') || html.includes('設立登記')) { status = '核准設立'; isActive = true; }
  else if (html.includes('廢止'))   status = '廢止';
  else if (html.includes('撤銷'))   status = '撤銷';
  else if (html.includes('解散'))   status = '解散';
  else if (html.includes('停業'))   status = '停業（非營業中）';

  // 若名稱與狀態都沒有抓到，視為查無
  if (!name && !status) return { found: false, ban };

  // 負責人 / 代表人
  const respM = html.match(/(?:代表人|負責人)[^<]*<\/th>\s*<td[^>]*>\s*([^<\r\n]{1,20}?)\s*<\/td>/i);
  const responsible = respM ? respM[1].trim() : '';

  // 地址
  const addrM = html.match(/(?:所在地|地\s*址)[^<]*<\/th>\s*<td[^>]*>\s*([^<\r\n]{5,80}?)\s*<\/td>/i);
  const address = addrM ? addrM[1].trim() : '';

  // 資本額
  const capM = html.match(/資本(?:總)?額[^<]*<\/th>\s*<td[^>]*>\s*([0-9,]+)\s*<\/td>/i);
  const capital = capM ? capM[1].replace(/,/g, '') : '';

  // 設立日期
  const dateM = html.match(/設立(?:日期|登記)[^<]*<\/th>\s*<td[^>]*>\s*(\d{7,8})\s*<\/td>/i);
  const setupDate = dateM ? dateM[1] : '';

  // 組織種類
  const orgM = html.match(/組織(?:種類|型態)[^<]*<\/th>\s*<td[^>]*>\s*([^<\r\n]{1,30}?)\s*<\/td>/i);
  const orgType = orgM ? orgM[1].trim() : '';

  return {
    found: true, ban, name,
    status:      status || (isActive ? '核准設立' : '已查到資料'),
    statusOk:    isActive,
    responsible, address, capital, setupDate, orgType,
    source: 'findbiz.nat.gov.tw',
  };
}

function parseTwincn(html, ban) {
  if (!html || html.length < 200) return { found: false, ban };

  function tf(label) {
    const re = new RegExp(label + '[：:]\\s*([^<\\r\\n,，]{1,40})', 'i');
    const m  = html.match(re);
    if (!m) return '';
    return m[1].replace(/&amp;/g,'&').replace(/[)）\"\/>]+$/, '').trim();
  }

  const h1M      = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const name     = h1M ? h1M[1].replace(/<[^>]+>/g, '').trim() : '';
  const taxStatus = tf('稅籍狀態');
  const invRaw    = tf('使用統一發票');
  const invFlag   = invRaw === '是' || invRaw === 'Y' ? 'Y'
                  : invRaw === '否' || invRaw === 'N' ? 'N'
                  : null;

  // 負責人 / 代表人
  const responsible = tf('代表人姓名') || tf('負責人姓名') || tf('負責人');

  // 地址
  const address = tf('登記地址') || tf('所在地') || tf('地址');

  // 資本額
  const capM = html.match(/資本(?:總)?額[：:]\s*([\d,]+)/);
  const capital = capM ? capM[1].replace(/,/g,'') : '';

  // 設立日期
  const setupDate = tf('設立日期') || tf('登記日期');

  // 組織種類
  const orgType = tf('組織種類') || tf('組織型態') || tf('組織別');

  if (!name && !taxStatus) return { found: false, ban };
  const isActive = taxStatus.includes('營業中') && !taxStatus.includes('非營業');
  return {
    found: true, ban, name,
    status:      taxStatus,
    statusOk:    isActive,
    invoiceFlag: invFlag,
    responsible, address, capital, setupDate, orgType,
    source:      'twincn.com',
  };
}
