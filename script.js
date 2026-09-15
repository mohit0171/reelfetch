/* ReelFetch frontend — talks to Node+MySQL backend at API_BASE.
   If backend is offline, gracefully falls back to demo mode. */

const API_BASE = 'http://localhost:3001';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const urlInput = $('#urlInput'),
  fetchBtn = $('#fetchBtn'),
  pasteBtn = $('#pasteBtn'),
  clearBtn = $('#clearBtn'),
  linkStatus = $('#linkStatus'),
  inputWrap = document.querySelector('.input-wrap'),
  loaderBox = $('#loaderBox'),
  loaderTitle = $('#loaderTitle'),
  loaderStep = $('#loaderStep'),
  loaderPct = $('#loaderPct'),
  progressFill = $('#progressFill'),
  stepsList = $$('#stepsList li'),
  resultBox = $('#resultBox'),
  downloadBtn = $('#downloadBtn'),
  resetBtn = $('#resetBtn'),
  dlProgress = $('#dlProgress'),
  dlFill = $('#dlFill');

const QMAP = {
  'HD 1080p': 'hd',
  'SD 720p': 'sd',
  'Audio MP3': 'audio'
};

let lastFetch = null; // { url, fetchId, info }

const PATTERNS = {
  instagram: /(instagram\.com\/(reel|reels|p)\/)/i,
  facebook: /(facebook\.com\/(reel|watch|share)|fb\.watch)/i,
  youtube: /(youtube\.com\/shorts\/|youtu\.be\/)/i,
  tiktok: /(tiktok\.com\/(@.+\/video|v|t\/))/i,
};

const NAMES = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube Shorts',
  tiktok: 'TikTok'
};

let currentSource = 'instagram',
  busy = false,
  timers = [];

const later = (fn, ms) => {
  const t = setTimeout(fn, ms);
  timers.push(t);
  return t;
};

const clearTimers = () => {
  timers.forEach(clearTimeout);
  timers = [];
};

const setStatus = (msg, cls) => {
  linkStatus.textContent = msg;
  linkStatus.className = 'link-status ' + (cls || 'idle');
};

function detectSource(url) {
  for (const k in PATTERNS) {
    if (PATTERNS[k].test(url)) return k;
  }

  return null;
}

function looksLikeUrl(v) {
  return /^(https?:\/\/)?[\w-]+\.[\w]{2,}.*$/i.test(v.trim());
}


/* ---- live validation as user types/pastes ---- */

urlInput.addEventListener('input', () => {
  const v = urlInput.value.trim();

  clearBtn.classList.toggle('hidden', !v);
  resultBox.classList.add('hidden');

  if (!v) {
    inputWrap.className = 'input-wrap';
    setStatus('Awaiting link…', 'idle');
    return;
  }

  const src = detectSource(v);

  if (src) {
    currentSource = src;
    syncTabs();

    inputWrap.className = 'input-wrap ok';

    setStatus(
      '✔ ' + NAMES[src] + ' link detected — ready to fetch',
      'ok'
    );

  } else if (looksLikeUrl(v)) {

    inputWrap.className = 'input-wrap';

    setStatus(
      '⚠ Link pasted — press Fetch to analyze',
      'busy'
    );

  } else {

    inputWrap.className = 'input-wrap err';

    setStatus(
      '✘ That doesn\'t look like a valid URL',
      'err'
    );
  }
});


/* auto-fetch shortly after a paste = the "small loading area after pasting" */

urlInput.addEventListener('paste', () => {
  later(() => {
    if (urlInput.value.trim()) {
      startFetch(true);
    }
  }, 450);
});


/* ---- paste-from-clipboard button ---- */

pasteBtn.addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();

    if (t) {
      urlInput.value = t.trim();
      urlInput.dispatchEvent(new Event('input'));
      startFetch(true);
    } else {
      toast(
        'Clipboard is empty — copy a reel link first',
        'err'
      );
    }

  } catch {
    toast(
      'Clipboard blocked — press Ctrl+V to paste manually',
      'err'
    );

    urlInput.focus();
  }
});


clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  urlInput.dispatchEvent(new Event('input'));
  urlInput.focus();
});


/* ---- platform tabs ---- */

function syncTabs() {
  $$('#platformTabs .ptab').forEach(b => {
    b.classList.toggle(
      'active',
      b.dataset.p === currentSource
    );
  });
}

$$('#platformTabs .ptab').forEach(b => {
  b.addEventListener('click', () => {

    currentSource = b.dataset.p;

    syncTabs();

    urlInput.focus();

    toast(
      NAMES[currentSource] + ' mode selected — paste a link',
      'ok'
    );
  });
});


/* ---- fetch button ---- */

fetchBtn.addEventListener('click', () => {
  startFetch(false);
});

urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    startFetch(false);
  }
});


const STEPS = [
  'Validating link',
  'Connecting to source',
  'Fetching HD media',
  'Preparing preview'
];


/* ---- Loading animation ---- */

function driveLoader(promise, onStep) {

  let pct = 0,
    step = 0,
    done = false;


  /*
   * FIX:
   * `mark` MUST be created before `onStep(0)` is called.
   *
   * Previously the code did:
   *
   * onStep(0);
   * const mark = ...
   *
   * But onStep was:
   *
   * (i) => mark(i, 'on')
   *
   * Therefore JavaScript tried to access `mark`
   * before initialization.
   */

  const mark = (i, cls) => {

    stepsList.forEach((li, k) => {

      if (k < i) {

        li.className = 'done';
        li.querySelector('i').textContent = '✓';

      } else if (k === i) {

        li.className = cls;

        if (cls === 'done') {
          li.querySelector('i').textContent = '✓';
        }

      } else {

        li.className = '';
        li.querySelector('i').textContent = k + 1;

      }

    });
  };


  /* Track promise completion */

  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );


  loaderStep.textContent = STEPS[0];

  if (onStep) {
    onStep(0);
  }


  /* Update progress UI */

  const paint = () => {

    loaderPct.textContent =
      Math.floor(pct) + '%';

    progressFill.style.width =
      pct + '%';


    const ns = Math.min(
      3,
      Math.floor(pct / 25)
    );


    if (ns !== step) {

      step = ns;

      loaderStep.textContent =
        STEPS[step];

      setStatus(
        '⏳ ' + STEPS[step] + '…',
        'busy'
      );

      if (onStep) {
        onStep(step);
      }
    }
  };


  /* Progress animation */

  const tick = () => {

    if (done) {

      pct = 100;
      step = 3;

      paint();


      stepsList.forEach((li) => {

        li.className = 'done';

        li.querySelector('i').textContent =
          '✓';

      });

      return;
    }


    pct = Math.min(
      90,
      pct + 2 + Math.random() * 5
    );

    paint();


    if (!done) {
      later(tick, 120);
    }
  };


  paint();
  tick();


  return {
    mark
  };
}


/* ---- reset loader UI ---- */

function resetLoaderUI(auto) {

  busy = true;

  clearTimers();

  resultBox.classList.add('hidden');

  loaderBox.classList.remove('hidden');

  stepsList.forEach((li, i) => {

    li.className =
      i === 0 ? 'on' : '';

    li.querySelector('i').textContent =
      i + 1;
  });


  fetchBtn.classList.add('loading');

  fetchBtn.querySelector(
    '.fetch-label'
  ).textContent = 'Fetching…';


  loaderPct.textContent = '0%';

  progressFill.style.width = '0%';


  loaderTitle.textContent =
    auto
      ? 'Link pasted — fetching your reel…'
      : 'Fetching your reel…';


  setStatus(
    '⏳ ' + STEPS[0] + '…',
    'busy'
  );
}


/* ---- failed loader ---- */

function finishLoaderFail(msg) {

  busy = false;

  fetchBtn.classList.remove('loading');

  fetchBtn.querySelector(
    '.fetch-label'
  ).textContent = 'Fetch Reel';

  loaderBox.classList.add('hidden');

  setStatus(
    '✘ ' + msg,
    'err'
  );

  shake();

  toast(
    msg,
    'err'
  );
}


/* ---- Start fetch ---- */

async function startFetch(auto) {

  const v = urlInput.value.trim();


  if (busy) {
    return;
  }


  if (!v) {

    shake();

    setStatus(
      '⚠ Paste a reel link first',
      'err'
    );

    urlInput.focus();

    return;
  }


  const src =
    detectSource(v) ||
    (looksLikeUrl(v)
      ? currentSource
      : null);


  if (!src) {

    shake();

    setStatus(
      '✘ Unsupported link — use Instagram, Facebook, Shorts or TikTok',
      'err'
    );

    toast(
      'Unsupported link format',
      'err'
    );

    return;
  }


  currentSource = src;

  syncTabs();

  resetLoaderUI(auto);


  /* REAL backend call — POST /api/resolve */

  const ctrl =
    new AbortController();


  const timeout =
    setTimeout(
      () => ctrl.abort(),
      65000
    );


  const req =
    fetch(
      API_BASE + '/api/resolve',
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          url: v
        }),

        signal: ctrl.signal
      }
    )
    .then(async (r) => {

      const data =
        await r.json()
          .catch(() => ({}));


      if (
        !r.ok ||
        !data.ok
      ) {

        throw new Error(
          data.error ||
          ('Server error ' + r.status)
        );
      }


      return data;
    })
    .finally(() => {
      clearTimeout(timeout);
    });


  /*
   * FIXED:
   * driveLoader now safely executes:
   *
   * onStep(0)
   *
   * because `mark` has already been initialized
   * inside driveLoader().
   */

  driveLoader(
    req,
    (i) => {
      // No direct reference to an uninitialized
      // outer `mark` variable.
      if (i >= 0 && i < stepsList.length) {
        stepsList.forEach((li, k) => {

          if (k < i) {

            li.className = 'done';

            li.querySelector('i').textContent =
              '✓';

          } else if (k === i) {

            li.className = 'on';

          } else {

            li.className = '';

            li.querySelector('i').textContent =
              k + 1;
          }

        });
      }
    }
  );


  try {

    const data =
      await req;


    lastFetch = {
      url: v,
      fetchId: data.fetchId || null,
      info: data
    };


    showResult(data);


  } catch (err) {

    if (
      /Failed to fetch|Load failed|NetworkError|abort/i
        .test(err.message || err)
    ) {

      /*
       * backend offline → clearly-labelled demo fallback
       */

      console.warn(
        '[ReelFetch] backend offline, demo fallback:',
        err.message
      );


      setStatus(
        '⚠ Backend offline — showing demo preview',
        'busy'
      );


      lastFetch = {
        url: v,
        fetchId: null,
        info: null
      };


      later(
        () => showResult(null),
        400
      );


    } else {

      finishLoaderFail(
        err.message ||
        'Could not fetch this reel.'
      );
    }
  }
}


/* ---- shake input ---- */

function shake() {

  inputWrap.classList.remove('err');

  void inputWrap.offsetWidth;

  inputWrap.classList.add('err');
}


/* ---- format duration ---- */

function fmtDur(s) {

  if (!s && s !== 0) {
    return '0:30';
  }

  s = Math.round(s);

  return (
    Math.floor(s / 60) +
    ':' +
    String(s % 60).padStart(2, '0')
  );
}


/* ---- format file size ---- */

function fmtSize(b) {

  if (!b) {
    return '~? MB';
  }


  return b > 1048576
    ? '~' +
      (b / 1048576).toFixed(1) +
      ' MB'
    : '~' +
      Math.round(b / 1024) +
      ' KB';
}


/* ---- Show result ---- */

function showResult(data) {

  busy = false;

  fetchBtn.classList.remove(
    'loading'
  );

  fetchBtn.querySelector(
    '.fetch-label'
  ).textContent = 'Fetch Reel';


  loaderBox.classList.add(
    'hidden'
  );


  setStatus(
    '✔ Reel ready — pick a quality & download',
    'ok'
  );


  $('#resSrc').textContent =
    data?.platform ||
    currentSource;


  if (data) {

    const base =
      (
        data.title ||
        'reel_video'
      )
      .replace(
        /[^\w\- ]+/g,
        ''
      )
      .trim()
      .slice(0, 60) ||
      'reel_video';


    $('#resTitle').textContent =
      base + '.mp4';


    $('#resDur').textContent =
      fmtDur(data.duration) +
      (
        data.height
          ? ' • ' + data.height + 'p'
          : ' • HD'
      );


    $('#resMeta').textContent =
      'MP4' +
      (
        data.width &&
        data.height
          ? ' • ' +
            data.width +
            '×' +
            data.height
          : ''
      ) +
      ' • ' +
      fmtSize(data.filesize) +
      (
        data.uploader
          ? ' • @' +
            data.uploader
          : ''
      ) +
      ' • No watermark';


    toast(
      'Reel fetched & saved to history',
      'ok'
    );

    refreshLiveStats(); // counters changed on the server — update the live tiles now


  } else {

    const id =
      Math.random()
        .toString(36)
        .slice(2, 10);


    $('#resTitle').textContent =
      'reel_' +
      id +
      '.mp4 (demo)';


    $('#resDur').textContent =
      '0:' +
      (
        15 +
        Math.floor(
          Math.random() * 40
        )
      ) +
      ' • HD';


    $('#resMeta').textContent =
      'Demo preview — start the backend for real metadata';


    toast(
      'Demo preview (backend offline)',
      'ok'
    );
  }


  resultBox.classList.remove(
    'hidden'
  );


  resultBox.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest'
  });
}


/* ---- quality + REAL download via backend ---- */

function selectedQuality() {

  const b =
    document.querySelector(
      '#qualityRow .qbtn.active'
    );


  return {
    label:
      b
        ? b.dataset.q
        : 'HD 1080p',

    code:
      QMAP[
        b
          ? b.dataset.q
          : 'HD 1080p'
      ] || 'hd'
  };
}


$('#qualityRow').addEventListener(
  'click',
  e => {

    const b =
      e.target.closest('.qbtn');


    if (!b) {
      return;
    }


    $$('#qualityRow .qbtn')
      .forEach(x =>
        x.classList.remove('active')
      );


    b.classList.add('active');


    const dq =
      $('#dlQ');


    if (dq) {
      dq.textContent =
        b.dataset.q;
    }
  }
);


/* ---- Download ---- */

downloadBtn.addEventListener(
  'click',
  () => {

    if (!lastFetch) {

      toast(
        'Fetch a reel first',
        'err'
      );

      return;
    }


    const {
      label,
      code
    } = selectedQuality();


    /* demo fallback when backend never resolved */

    if (!lastFetch.info) {

      dlProgress.classList.remove(
        'hidden'
      );


      let p = 0;


      downloadBtn.textContent =
        '⏳ Preparing…';


      const iv =
        setInterval(() => {

          p =
            Math.min(
              100,
              p +
              8 +
              Math.random() * 12
            );


          dlFill.style.width =
            p + '%';


          downloadBtn.textContent =
            '⏳ Downloading ' +
            Math.floor(p) +
            '%';


          if (p >= 100) {

            clearInterval(iv);


            downloadBtn.innerHTML =
              '⬇ Download <span id="dlQ">' +
              label +
              '</span>';


            toast(
              'Demo mode — start the backend for real downloads',
              'ok'
            );
          }

        }, 150);


      return;
    }


    /* REAL download: stream from backend */

    const dlUrl =
      API_BASE +
      '/api/download?url=' +
      encodeURIComponent(
        lastFetch.url
      ) +
      '&quality=' +
      code +
      (
        lastFetch.fetchId
          ? '&fetchId=' +
            lastFetch.fetchId
          : ''
      );


    dlProgress.classList.remove(
      'hidden'
    );


    dlFill.style.width =
      '0%';


    downloadBtn.textContent =
      '⏳ Connecting…';


    downloadBtn.disabled =
      true;


    later(refreshLiveStats, 1500); // download is logged server-side on request — refresh tiles shortly after

    fetch(dlUrl)
      .then(async (r) => {

        if (!r.ok) {

          const j =
            await r.json()
              .catch(() => ({}));


          throw new Error(
            j.error ||
            (
              'Download failed (' +
              r.status +
              ')'
            )
          );
        }


        const total =
          Number(
            r.headers.get(
              'content-length'
            )
          ) || 0;


        const reader =
          r.body.getReader();


        const chunks = [];

        let got = 0;


        for (;;) {

          const {
            done,
            value
          } =
            await reader.read();


          if (done) {
            break;
          }


          chunks.push(value);

          got += value.length;


          if (total) {

            const pc =
              Math.floor(
                got /
                total *
                100
              );


            dlFill.style.width =
              pc + '%';


            downloadBtn.textContent =
              '⏳ Downloading ' +
              pc +
              '%';


          } else {

            downloadBtn.textContent =
              '⏳ Downloading ' +
              (
                got /
                1048576
              ).toFixed(1) +
              ' MB';
          }
        }


        const blob =
          new Blob(
            chunks,
            {
              type:
                code === 'audio'
                  ? 'audio/mpeg'
                  : 'video/mp4'
            }
          );


        const a =
          document.createElement('a');


        a.href =
          URL.createObjectURL(blob);


        const extension = code === 'audio' ? 'mp3' : 'mp4';

a.download = `ReelFetch_${Date.now()}.${extension}`;


        document.body.appendChild(a);

        a.click();

        a.remove();


        setTimeout(
          () =>
            URL.revokeObjectURL(
              a.href
            ),
          5000
        );


        dlFill.style.width =
          '100%';


        downloadBtn.innerHTML =
          '⬇ Download <span id="dlQ">' +
          label +
          '</span>';


        downloadBtn.disabled =
          false;


        toast(
          'Download complete 🎉',
          'ok'
        );

      })
      .catch((err) => {

        downloadBtn.innerHTML =
          '⬇ Download <span id="dlQ">' +
          label +
          '</span>';


        downloadBtn.disabled =
          false;


        toast(
          err.message,
          'err'
        );
      });
  }
);


/* ---- Reset ---- */

resetBtn.addEventListener(
  'click',
  () => {

    clearTimers();

    busy = false;

    lastFetch = null;


    resultBox.classList.add(
      'hidden'
    );

    loaderBox.classList.add(
      'hidden'
    );


    dlProgress.classList.add(
      'hidden'
    );


    dlFill.style.width =
      '0%';


    urlInput.value = '';

    urlInput.dispatchEvent(
      new Event('input')
    );

    urlInput.focus();
  }
);


/* ---- toast ---- */

function toast(msg, type) {

  const t =
    $('#toast');


  t.textContent =
    msg;


  t.className =
    'toast show ' +
    (type || '');


  clearTimeout(t._h);


  t._h =
    setTimeout(
      () =>
        t.classList.remove(
          'show'
        ),
      2800
    );
}


/* ---- animated stat counters ---- */

const io =
  new IntersectionObserver(
    es =>
      es.forEach(e => {

        if (!e.isIntersecting) {
          return;
        }


        const el =
          e.target;


        const end =
          parseFloat(
            el.dataset.count
          );


        const dec =
          parseInt(
            el.dataset.dec || 0
          );


        const t0 =
          performance.now();


        const step =
          now => {

            const k =
              Math.min(
                1,
                (now - t0) /
                1400
              );


            const ease =
              1 -
              Math.pow(
                1 - k,
                3
              );


            el.textContent =
              (
                end * ease
              ).toFixed(dec);


            if (k < 1) {
              requestAnimationFrame(
                step
              );
            }
          };


        requestAnimationFrame(
          step
        );


        io.unobserve(el);
      }),
    {
      threshold: .5
    }
  );


$$('[data-count]')
  .forEach(el =>
    io.observe(el)
  );


/* ---- FAQ accordion ---- */

$('#faqList').addEventListener(
  'click',
  e => {

    const q =
      e.target.closest('.faq-q');


    if (!q) {
      return;
    }


    const item =
      q.parentElement;


    const ans =
      item.querySelector('.faq-a');


    const open =
      item.classList.contains(
        'open'
      );


    $$('.faq-item.open')
      .forEach(o => {

        o.classList.remove(
          'open'
        );


        o.querySelector(
          '.faq-a'
        ).style.maxHeight =
          null;
      });


    if (!open) {

      item.classList.add(
        'open'
      );


      ans.style.maxHeight =
        ans.scrollHeight +
        'px';
    }
  }
);


/* ---- mobile menu + nav highlight ---- */

$('#hamburger').addEventListener(
  'click',
  () =>
    $('#mobileMenu')
      .classList
      .toggle('open')
);


$$('#mobileMenu a')
  .forEach(a =>
    a.addEventListener(
      'click',
      () =>
        $('#mobileMenu')
          .classList
          .remove('open')
    )
  );


$$('.nav-links a')
  .forEach(a =>
    a.addEventListener(
      'click',
      () => {

        $$('.nav-links a')
          .forEach(x =>
            x.classList.remove(
              'active'
            )
          );


        a.classList.add(
          'active'
        );
      }
    )
  );


/* ---- backend status pill ---- */

(async () => {

  try {

    const r =
      await fetch(
        API_BASE +
        '/api/health'
      );


    const j =
      await r.json();


    if (j.ok) {

      const dot =
        document.querySelector(
          '.live-dot'
        );


      if (dot) {

        dot.innerHTML =
          '<i></i> backend live • db ' +
          (
            j.db || '?'
          );
      }
    }

  } catch {

    /* stays in demo mode silently */

  }

})();


/* ---- LIVE STATS (country-based tracking period) ----
   Polls GET /api/stats: fetches / downloads / users counted since the
   current tracking period started. The period resets to 0 whenever a
   request comes from a country not yet seen in it (server-side IP
   geolocation). The hero's static "avg. fetch time" tile is independent
   and is never touched here. */

const LIVE_STATS_POLL_MS = 15000;

const fmtLiveInt = (n) =>
  (Number(n) || 0).toLocaleString('en-US');

const periodAgo = (iso) => {

  if (!iso) {
    return '—';
  }

  const s =
    Math.max(
      0,
      Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    );

  if (s < 60) {
    return s + 's ago';
  }

  if (s < 3600) {
    return Math.floor(s / 60) + 'm ago';
  }

  if (s < 86400) {
    return Math.floor(s / 3600) + 'h ago';
  }

  return Math.floor(s / 86400) + 'd ago';

};

async function refreshLiveStats() {

  const elD = $('#statDownloads'),
    elF = $('#statFetches'),
    elU = $('#statUsers'),
    note = $('#statsNote');

  if (!elD || !elF || !elU) {
    return;
  }

  try {

    const r =
      await fetch(
        API_BASE +
        '/api/stats'
      );

    const j =
      await r.json();

    const s =
      j && j.stats;

    if (!j.ok || !s) {
      throw new Error('no stats');
    }

    elD.textContent =
      fmtLiveInt(s.downloads);

    elF.textContent =
      fmtLiveInt(s.fetches);

    elU.textContent =
      fmtLiveInt(s.users);

    if (note) {

      const c =
        Number(s.countries) || 0;

      note.textContent =
        'Tracking period started ' +
        periodAgo(s.periodStartedAt) +
        ' • ' +
        c +
        (c === 1 ? ' country' : ' countries') +
        ' active • resets when a first-time country joins';

    }

  } catch {

    elD.textContent = '—';
    elF.textContent = '—';
    elU.textContent = '—';

    if (note) {
      note.textContent =
        'Backend offline — live stats unavailable';
    }

  }

}


refreshLiveStats();

setInterval(
  refreshLiveStats,
  LIVE_STATS_POLL_MS
);

document.addEventListener(
  'visibilitychange',
  () => {
    if (!document.hidden) {
      refreshLiveStats();
    }
  }
);