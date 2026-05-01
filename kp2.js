/*!
 * Kinopub plugin for Lampa v2 (Tizen-focused)  v2.0.0-alpha
 * https://github.com/mainsync-afk/kinopub
 *
 * Источник kino.pub в карточке Lampa. Структура — копия filmix.js,
 * заменён только источник (kpapi). Авторизация — OAuth2 device-flow
 * (kinopub.tv/device-style), токены живут в Lampa.Storage с авто-refresh.
 */
(function() {
  'use strict';

  var PLUGIN_VERSION = '2.0.9-debug';

  /* ============================================================
   * REMOTE DEBUG LOGGER (опционально)
   * ============================================================
   * Включается одной командой через Lampa Terminal:
   *
   *   Lampa.Storage.set('kp2_log_url', 'http://<IP_ПК>:8765/l');
   *   location.reload();
   *
   * После релоада все console.log/warn/error/info + window.onerror +
   * unhandledrejection шлются GET-запросом к указанному URL (через
   * <Image> — без CORS-preflight, работает на старых Tizen WebView).
   *
   * На ПК запускается приёмник: python kp2_log_server.py
   * Выключение: Lampa.Storage.set('kp2_log_url', '');  → location.reload()
   * ============================================================ */
  (function() {
    // ВРЕМЕННЫЙ хардкод на период отладки на Tizen.
    // Когда логи станут не нужны — поставь LOG_URL_FALLBACK = '' и пушни.
    var LOG_URL_FALLBACK = 'http://192.168.10.200:8765/l';
    var logUrl = '';
    try { logUrl = (Lampa.Storage.get('kp2_log_url', '') || '').toString(); } catch (e) {}
    logUrl = logUrl && ('' + logUrl).replace(/^\s+|\s+$/g, '');
    if (!logUrl) logUrl = LOG_URL_FALLBACK;
    if (!logUrl) return;

    function ser(v) {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      var t = typeof v;
      if (t === 'string') return v;
      if (t === 'number' || t === 'boolean') return String(v);
      if (t === 'function') return '[Function ' + (v.name || 'anon') + ']';
      try { return JSON.stringify(v); }
      catch (e) {
        try { return String(v); } catch (e2) { return '[unserializable]'; }
      }
    }
    function send(level, args) {
      try {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(ser(args[i]));
        var line = '[' + level + '] ' + parts.join(' ');
        if (line.length > 1800) line = line.slice(0, 1800) + '\u2026[trunc]';
        var sep = logUrl.indexOf('?') < 0 ? '?' : '&';
        new Image().src = logUrl + sep + 'd=' + encodeURIComponent(line) + '&t=' + Date.now();
      } catch (e) {}
    }
    ['log','info','warn','error'].forEach(function(lvl) {
      var orig = console[lvl];
      console[lvl] = function() {
        try { if (orig) orig.apply(console, arguments); } catch (e) {}
        send(lvl, arguments);
      };
    });
    window.addEventListener('error', function(e) {
      send('uncaught', [
        (e.message || 'error') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0) + ':' + (e.colno || 0),
        (e.error && e.error.stack) ? e.error.stack : ''
      ]);
    });
    window.addEventListener('unhandledrejection', function(e) {
      var r = e.reason;
      send('reject', [
        r && (r.message || String(r)),
        (r && r.stack) ? r.stack : ''
      ]);
    });
    send('init', [
      'kp2 v' + PLUGIN_VERSION + ' logger online',
      'UA=' + (navigator.userAgent || '').slice(0, 140)
    ]);
  })();

  /* ---------- авторизационные креды и эндпойнты ---------- */
  var api_url   = 'https://api.srvkp.com/v1/';
  var COMPONENT = 'online_kinopub2';
  var SETTINGS  = 'kinopub2';
  var CHOICE_KEY = 'online_choice_kp2';
  var oauth_url = 'https://api.srvkp.com/oauth2/';
  // Креды из официального PWA kinopub. xbmc-секрет старого Kodi-аддона
  // отозван, эта пара — рабочая на момент v1.5.1.
  var KP_CLIENT_ID     = 'xbmc';
  var KP_CLIENT_SECRET = 'cgg3gtifu46urtfp2zp1nqtba0k2ezxh';

  var kp_token         = Lampa.Storage.get('kp_token',         '') || '';
  var kp_refresh_token = Lampa.Storage.get('kp_refresh_token', '') || '';

  // Модалка авторизации и поллинг — module-level, чтобы destroy() компонента
  // мог их прибить если активити закрыли посреди процесса.
  var modalopen = false;
  var ping_auth;

  /* ---------- helpers ---------- */

  function bearerHeaders() {
    return kp_token ? { Authorization: 'Bearer ' + kp_token } : {};
  }

  function urlEncodeForm(obj) {
    var pairs = [];
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
      pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    }
    return pairs.join('&');
  }

  /**
   * Refresh access_token через сохранённый refresh_token.
   * Вызывается автоматически из apiGet когда вернулся 401.
   * При успехе обновляем оба токена в памяти и Storage.
   * При неудаче — стираем оба, плагин при следующем запуске покажет device-flow.
   */
  /**
   * Обёртка над network.silent для kinopub-API с автоматическим refresh
   * при 401: один retry с подсасыванием нового access_token. Если refresh
   * тоже не удался (refresh_token истёк) — стираем токены и отдаём ошибку
   * наверх; в kpapi() при !kp_token откроется device-flow модалка.
   */
  function apiSilent(network, url, success, error) {
    var retried = false;
    function send() {
      network.silent(url, function(json) { success && success(json); }, function(xhr, code) {
        if (code === 401 && !retried && kp_refresh_token) {
          retried = true;
          refreshKpToken(send, function() { error && error(xhr, code); });
        } else {
          if (code === 401) {
            // refresh не помог — токен мёртв окончательно
            kp_token = '';
            Lampa.Storage.set('kp_token', '');
          }
          error && error(xhr, code);
        }
      }, false, { headers: bearerHeaders() });
    }
    send();
  }

  function refreshKpToken(onOk, onFail) {
    if (!kp_refresh_token) { onFail && onFail(); return; }
    var body = urlEncodeForm({
      grant_type:    'refresh_token',
      client_id:     KP_CLIENT_ID,
      client_secret: KP_CLIENT_SECRET,
      refresh_token: kp_refresh_token
    });
    var net2 = new Lampa.Reguest();
    net2.timeout(15000);
    // У kinopub все grant_type'ы идут на /oauth2/device — единый эндпойнт.
    net2.silent(oauth_url + 'device', function(json) {
      if (json && json.access_token) {
        kp_token = json.access_token;
        Lampa.Storage.set('kp_token', kp_token);
        if (json.refresh_token) {
          kp_refresh_token = json.refresh_token;
          Lampa.Storage.set('kp_refresh_token', kp_refresh_token);
        }
        if (json.expires_in) Lampa.Storage.set('kp_token_expires', Date.now() + json.expires_in * 1000);
        onOk && onOk();
      } else {
        kp_token = ''; kp_refresh_token = '';
        Lampa.Storage.set('kp_token', '');
        Lampa.Storage.set('kp_refresh_token', '');
        onFail && onFail();
      }
    }, function() {
      kp_token = ''; kp_refresh_token = '';
      Lampa.Storage.set('kp_token', '');
      Lampa.Storage.set('kp_refresh_token', '');
      onFail && onFail();
    }, body, {
      dataType: 'json',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  }

  function normalizeString(str) {
    return (str || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
  }

  function audioName(a, idx) {
    if (!a) return 'Audio ' + (idx + 1);
    var parts = [];
    if (a.author && a.author.title) parts.push(a.author.title);
    else {
      if (a.type && a.type.title) parts.push(a.type.title);
      if (a.lang) parts.push(a.lang);
    }
    return parts.join(' • ') || ('Audio ' + (idx + 1));
  }

  // Ключ для дедупликации озвучек: (lang, type.id, author.title) — так же
  // консолидирует kinopub в своём UI.
  function audioKey(a) {
    if (!a) return '';
    var t = (a.type && (a.type.id != null ? a.type.id : a.type.title)) || '';
    var au = (a.author && a.author.title) || '';
    return [a.lang || '', t, au].join('|');
  }

  /**
   * Собрать уникальные озвучки из episode.audios. Берём ОДИН эпизод-семпл
   * (обычно у всех серий сезона одинаковый набор), консолидируем по audioKey.
   */
  function collectVoices(sampleEp) {
    if (!sampleEp || !sampleEp.audios || !sampleEp.audios.length) return [];
    var seen = {};
    var out = [];
    sampleEp.audios.forEach(function(a, idx) {
      var key = audioKey(a);
      if (seen[key]) return;
      seen[key] = true;
      out.push({
        name:   audioName(a, idx),
        index:  (a.index != null ? a.index : idx),
        lang:   a.lang || '',
        author: (a.author && a.author.title) || '',
        type:   (a.type && a.type.title) || ''
      });
    });
    return out;
  }

  function qNum(q) {
    if (q == null) return 0;
    var s = String(q).toLowerCase();
    if (s.indexOf('2160') >= 0 || s.indexOf('4k') >= 0)  return 2160;
    if (s.indexOf('1440') >= 0)                          return 1440;
    if (s.indexOf('1080') >= 0)                          return 1080;
    if (s.indexOf('720')  >= 0)                          return 720;
    if (s.indexOf('480')  >= 0)                          return 480;
    if (s.indexOf('360')  >= 0)                          return 360;
    var n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  }

  function fileUrl(f) {
    if (!f) return '';
    if (typeof f.url === 'string') return f.url;
    if (f.url) {
      // Предпочитаем HLS — чанковый стрим стартует быстрее и плеер
      // адаптивно подбирает битрейт. http (прямой mp4) — фоллбэк.
      return f.url.hls4 || f.url.hls || f.url.http || '';
    }
    return '';
  }

  function buildQualityMap(files) {
    // qmap[quality] → HLS-url. Используем HLS везде: если у kinopub URL'ы
    // per-quality (variant playlist) — Lampa переключит между ними чисто;
    // если все одинаковые (master playlist) — hls.js сам адаптирует битрейт.
    // Микс HLS+HTTP в qmap ломал плавность (переключение на mp4 в hls-сессии
    // вызывало «лагает и стопается»).
    var qmap = {};
    var qarr = [];
    (files || []).forEach(function(f) {
      var n = qNum(f.quality);
      var u = fileUrl(f);
      if (n && u && !qmap[n + 'p']) {
        qmap[n + 'p'] = u;
        qarr.push(n);
      }
    });
    return { qmap: qmap, qarr: qarr };
  }

  function pickBestFile(files) {
    var sorted = (files || []).slice().sort(function(a, b) { return qNum(b.quality) - qNum(a.quality); });
    for (var i = 0; i < sorted.length; i++) {
      var u = fileUrl(sorted[i]);
      if (u) return { url: u, quality: qNum(sorted[i].quality) };
    }
    return null;
  }

  /* ==========================================================
   *                        ИСТОЧНИК
   * ========================================================== */

  function kpapi(component, _object) {
    console.log('[kp2] kpapi(): source factory called', {
      title: _object && _object.title,
      original_title: _object && _object.original_title,
      movie_id: _object && _object.movie && _object.movie.id
    });
    var network       = new Lampa.Reguest();
    var extract       = {};
    var results       = null;        // raw kinopub item
    var object        = _object;
    var wait_similars;
    var filter_items  = {};
    var choice = {
      season: 0,
      voice: 0,
      voice_name: ''
    };

    /* ---------- авторизация ---------- */

    // Если токена ещё нет — поднимаем модалку device-flow (как у filmix.js).
    // 1) POST /oauth2/device (grant_type=client_credentials) → {code, user_code, verification_uri}
    // 2) Показываем user_code, юзер вводит на kino.pub/pin
    // 3) Поллим /oauth2/device (grant_type=device_token, code=...) → {access_token, refresh_token}
    // 4) Сохраняем токены и перезагружаем страницу — плагин запускается уже авторизованным.
    if (!kp_token) {
      modalopen = true;
      var user_code   = '';
      var device_code = '';
      var verify_url  = 'https://kino.pub/pin';

      var modal = $(
        '<div>' +
        '<div class="broadcast__text">' + Lampa.Lang.translate('kp_modal_text').replace('{url}', verify_url) + '</div>' +
        '<div class="broadcast__device selector" style="text-align: center; background-color: darkslategrey; color: white;">' +
          Lampa.Lang.translate('kp_modal_wait') + '...' +
        '</div>' +
        '<br>' +
        '<div class="broadcast__scan"><div></div></div>' +
        '</div>'
      );

      var openModal = function() {
        var contrl = Lampa.Controller.enabled().name;
        Lampa.Modal.open({
          title: 'Kinopub',
          html:  modal,
          onBack: function() {
            Lampa.Modal.close();
            clearInterval(ping_auth);
            modalopen = false;
            Lampa.Controller.toggle(contrl);
          },
          onSelect: function() {
            // OK на коде → копирование в буфер
            if (user_code) {
              Lampa.Utils.copyTextToClipboard(user_code, function() {
                Lampa.Noty.show(Lampa.Lang.translate('copy_secuses'));
              }, function() {
                Lampa.Noty.show(Lampa.Lang.translate('copy_fail'));
              });
            }
          }
        });
      };

      // Поллинг: ждём пока юзер активирует код на сайте
      ping_auth = setInterval(function() {
        if (!device_code) return;
        var body = urlEncodeForm({
          grant_type:    'device_token',
          client_id:     KP_CLIENT_ID,
          client_secret: KP_CLIENT_SECRET,
          code:          device_code
        });
        network.silent(oauth_url + 'device', function(json) {
          if (json && json.access_token) {
            clearInterval(ping_auth);
            Lampa.Modal.close();
            modalopen = false;
            Lampa.Storage.set('kp_token', json.access_token);
            if (json.refresh_token) Lampa.Storage.set('kp_refresh_token', json.refresh_token);
            if (json.expires_in)    Lampa.Storage.set('kp_token_expires', Date.now() + json.expires_in * 1000);
            window.location.reload();
          }
          // прочее — ждём, юзер ещё не ввёл код
        }, function() { /* 4xx до активации — нормально, продолжаем поллинг */ }, body, {
          dataType: 'json',
          headers:  { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      }, 5000);

      // Запрос device-кода (Kodi-аддон использует именно 'device_code',
      // 'client_credentials' kinopub отвергает с 'unauthorized_client').
      var initBody = urlEncodeForm({
        grant_type:    'device_code',
        client_id:     KP_CLIENT_ID,
        client_secret: KP_CLIENT_SECRET
      });
      network.quiet(oauth_url + 'device', function(found) {
        if (found && found.code && found.user_code) {
          device_code = found.code;
          user_code   = found.user_code;
          if (found.verification_uri) {
            verify_url = found.verification_uri;
            modal.find('.broadcast__text').text(Lampa.Lang.translate('kp_modal_text').replace('{url}', verify_url));
          }
          modal.find('.broadcast__device').text(user_code);
          if (!$('.modal').length) openModal();
        } else {
          Lampa.Noty.show(Lampa.Lang.translate('kp_auth_error'));
        }
      }, function(a, c) {
        Lampa.Noty.show(Lampa.Lang.translate('kp_auth_error') + (c ? ' (' + c + ')' : ''));
      }, initBody, {
        dataType: 'json',
        headers:  { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      component.loading(false);
      return;
    }

    /* ---------- API source-методы ---------- */

    this.search = function(_object, sim) {
      if (wait_similars) this.find(sim[0].id);
    };

    this.searchByTitle = function(_object, query) {
      var _this = this;
      object    = _object;

      var year  = parseInt((object.movie.release_date || object.movie.first_air_date || '0000').slice(0, 4));
      var orig  = object.movie.original_name  || object.movie.original_title || '';
      var ru    = object.movie.name           || object.movie.title          || '';
      var imdb  = (object.movie.imdb_id || '').toString().replace(/^tt/, '');
      var kpid  = object.movie.kinopoisk_id ? String(object.movie.kinopoisk_id) : '';
      var url   = api_url + 'items/search?q=' + encodeURIComponent(query) + '&perpage=20';

      network.clear();
      apiSilent(network, url, function(json) {
        var items = (json && json.items) || [];

        var card = pickKpCard(items, { year: year, orig: orig, ru: ru, imdb: imdb, kpid: kpid });

        if (card) _this.find(card.id);
        else if (items.length) {
          // Фоллбэк: всё-таки показываем similars, если ни один из стратегий не выбрал
          wait_similars = true;
          component.similars(items.map(toSimilar));
          component.loading(false);
        } else component.doesNotAnswer();
      }, function(a, c) {
        component.doesNotAnswer();
      });
    };

    /**
     * Однозначно определить карточку kinopub под текущий тайтл из Lampa.
     * Возвращает item или null.
     *
     * Приоритет совпадения (от наиболее надёжного к наименее):
     *  1) imdb_id
     *  2) kinopoisk_id
     *  3) точный год + название (RU или ORIG) пересекается с title/subname
     *  4) точный год + единственная карточка с таким годом
     *  5) ±1 год + единственная карточка
     *  6) точный год + первая карточка (из нескольких — берём верхнюю)
     */
    function pickKpCard(items, ctx) {
      if (!items || !items.length) return null;

      // 1) IMDb ID
      if (ctx.imdb) {
        var byImdb = items.find(function(c) {
          return c.imdb && String(c.imdb).replace(/^tt/, '') === ctx.imdb;
        });
        if (byImdb) return byImdb;
      }

      // 2) Kinopoisk ID
      if (ctx.kpid) {
        var byKp = items.find(function(c) {
          return c.kinopoisk && String(c.kinopoisk) === ctx.kpid;
        });
        if (byKp) return byKp;
      }

      // 3) Год + название
      var nOrig = normalizeString(ctx.orig);
      var nRu   = normalizeString(ctx.ru);
      var exact = items.filter(function(c) { return c.year == ctx.year; });

      if (exact.length) {
        if (nOrig || nRu) {
          var byTitle = exact.find(function(c) {
            var blob = normalizeString((c.title || '') + (c.subname || ''));
            return (nOrig && blob.indexOf(nOrig) !== -1) ||
                   (nRu   && blob.indexOf(nRu)   !== -1);
          });
          if (byTitle) return byTitle;
        }
        // 4) Единственный с точным годом — берём
        if (exact.length === 1) return exact[0];
        // 6) Несколько с точным годом — берём первый (kinopub отдаёт наиболее релевантные сверху)
        return exact[0];
      }

      // 5) ±1 год — единственный
      var near = items.filter(function(c) {
        var y = parseInt(c.year) || 0;
        return ctx.year && Math.abs(y - ctx.year) <= 1;
      });
      if (near.length === 1) return near[0];

      return null;
    }

    function toSimilar(it) {
      return {
        id:             it.id,
        title:          it.title || it.subname || '',
        original_title: (it.title && it.subname && it.title !== it.subname) ? it.subname : '',
        year:           it.year,
        start_date:     it.year ? it.year + '' : '',
        rating:         it.rating || it.imdb_rating || null,
        countries:      (it.countries || []).map(function(c) { return c.title || c; }),
        categories:     (it.genres    || []).map(function(g) { return g.title || g; })
      };
    }

    this.find = function(itemId) {
      var url = api_url + 'items/' + itemId;
      network.clear();
      network.timeout(10000);
      apiSilent(network, url, function(found) {
        if (found && found.item) {
          success(found.item);
          component.loading(false);
        } else component.doesNotAnswer();
      }, function() {
        component.doesNotAnswer();
      });
    };

    this.extendChoice = function(saved) {
      Lampa.Arrays.extend(choice, saved, true);
    };

    this.reset = function() {
      component.reset();
      choice = { season: 0, voice: 0, voice_name: '' };
      extractData(results);
      filter();
      append(filtred());
    };

    this.filter = function(type, a, b) {
      choice[a.stype] = b.index;
      if (a.stype == 'voice') choice.voice_name = filter_items.voice[b.index];
      component.reset();
      extractData(results);
      filter();
      append(filtred());
    };

    this.destroy = function() {
      network.clear();
      results = null;
    };

    // refresh() удалён в v1.4.15 — он триггерил рекурсию через empty()
    // (см. комментарий в component.start). Подписи озвучки обновляются
    // только при перезаходе в карточку. Дальнейший on-the-fly refresh —
    // отдельная задача, через корректное событие.

    function success(item) {
      results = item;
      // Сериал — сначала пробуем узнать у TMDB реальное число эпизодов на сезон,
      // чтобы отрезать «лишние» (kinopub складывает спецвыпуски в конец сезона
      // под номерами 9, 10 и т.п.). Для фильмов сразу идём дальше.
      var seasons = (item && item.seasons) || [];
      if (!seasons.length || typeof object.movie.id !== 'number' || !object.movie.name) {
        afterTmdb({});
        return;
      }
      var counts = {};
      var pending = 0;
      var tmdb_id = object.movie.id;
      var lang    = Lampa.Storage.get('language', 'ru');
      seasons.forEach(function(s) {
        var num = parseInt(s.number);
        if (!num || num < 1) return; // явный season 0 — не запрашиваем, и так специал
        pending++;
        var url2 = Lampa.TMDB.api('tv/' + tmdb_id + '/season/' + num + '?api_key=' + Lampa.TMDB.key() + '&language=' + lang);
        var net2 = new Lampa.Reguest();
        net2.timeout(8000);
        net2['native'](url2, function(data) {
          if (data && data.episodes) counts[num] = data.episodes.length;
          if (--pending === 0) afterTmdb(counts);
        }, function() {
          if (--pending === 0) afterTmdb(counts);
        });
      });
      if (pending === 0) afterTmdb(counts);

      function afterTmdb(map) {
        results.__tmdb_counts = map;
        extractData(item);
        filter();
        append(filtred());
      }
    }

    /* ---------- разбор kinopub item в структуру extract[transl_id] ---------- */

    function makeEpisodeEntry(seasonNum, ep, transl_id) {
      // У kinopub все аудио-дорожки уже встроены в один и тот же стрим — отдаём
      // тот URL что выдало API. Озвучку выберет плеер через hls.audioTrack /
      // video.audioTracks (см. listener в startPlugin).
      var picked = pickBestFile(ep.files);
      if (!picked) return null;
      var qq = buildQualityMap(ep.files);
      return {
        id:             seasonNum + '_' + ep.number,
        comment:        ep.number + ' ' + Lampa.Lang.translate('torrent_serial_episode'),
        title:          ep.title || '',
        file:           picked.url,
        episode:        ep.number,
        season:         seasonNum,
        quality:        picked.quality,
        qualities:      qq.qarr,
        qualities_map:  qq.qmap,
        translation:    transl_id,
        // компактный список аудио конкретно для этой серии — нужен чтобы
        // помечать в списке серии где выбранной пользователем дорожки нет
        audios:         (ep.audios || []).map(function(a) {
          return {
            lang:   a.lang || '',
            author: (a.author && a.author.title) || '',
            type:   (a.type   && a.type.title)   || ''
          };
        })
      };
    }

    function sortSeasonsForDisplay(seasons) {
      // Реальные сезоны (number > 0) сортируем ASC, явный season 0 (специалы) — в конец.
      return seasons.slice().sort(function(a, b) {
        var an = parseInt(a.number) || 0;
        var bn = parseInt(b.number) || 0;
        if (an === 0 && bn !== 0) return 1;
        if (bn === 0 && an !== 0) return -1;
        return an - bn;
      });
    }

    function extractData(item) {
      extract = {};
      if (!item) return;

      if (item.seasons && item.seasons.length) {
        var sortedSeasons = sortSeasonsForDisplay(item.seasons);
        var tmdbCounts    = (results && results.__tmdb_counts) || {};

        // Берём набор озвучек из первого реального эпизода (у kinopub он
        // обычно одинаковый по всему сериалу). Консолидируем по audioKey,
        // чтобы наш список совпадал с тем что показывает kinopub в вебе.
        var firstReal = null;
        for (var i = 0; i < sortedSeasons.length; i++) {
          var n = parseInt(sortedSeasons[i].number) || 0;
          if (n > 0 && sortedSeasons[i].episodes && sortedSeasons[i].episodes.length) {
            firstReal = sortedSeasons[i].episodes[0];
            break;
          }
        }
        var voices = collectVoices(firstReal);
        if (!voices.length) voices.push({ name: '', index: 0, lang: '', author: '', type: '' });

        // ОДНА «папка» сезонов на всех. URL у kinopub один и тот же независимо
        // от выбора озвучки — переключение делает плеер через hls.audioTrack.
        var transl_id   = 1;
        var seasonsList = [];
        var specials    = [];
        var seasonIdx   = 0;

        sortedSeasons.forEach(function(season) {
          var num = parseInt(season.number) || 0;

          if (num === 0) {
            (season.episodes || []).forEach(function(ep) {
              var entry = makeEpisodeEntry(num, ep, transl_id);
              if (entry) specials.push(entry);
            });
            return;
          }

          var tmdbMax = tmdbCounts[num];
          var picks   = [];
          (season.episodes || []).forEach(function(ep) {
            var entry = makeEpisodeEntry(num, ep, transl_id);
            if (!entry) return;
            if (tmdbMax != null && ep.number > tmdbMax) {
              specials.push(entry);
            } else {
              picks.push(entry);
            }
          });

          seasonIdx++;
          seasonsList.push({
            id:          seasonIdx,
            comment:     num + ' ' + Lampa.Lang.translate('torrent_serial_season'),
            folder:      picks,
            translation: transl_id
          });
        });

        if (specials.length) {
          seasonIdx++;
          seasonsList.push({
            id:          seasonIdx,
            comment:     Lampa.Lang.translate('online_specials'),
            folder:      specials,
            translation: transl_id,
            specials:    true
          });
        }

        extract[transl_id] = { json: seasonsList, file: '', voice_name: '' };
        results.__voices  = voices;
      }
      else if (item.videos && item.videos.length) {
        // Фильм / multi-часть
        item.videos.forEach(function(v, idx) {
          var picked = pickBestFile(v.files);
          if (!picked) return;
          var qq = buildQualityMap(v.files);

          var name = '';
          if (v.audios && v.audios.length === 1) name = audioName(v.audios[0], 0);
          else if (v.audios && v.audios.length > 1) {
            // Для фильма с несколькими аудио берём «дубляж» как имя (или первое)
            name = audioName(v.audios[0], 0);
          }
          if (!name && item.videos.length > 1) name = (v.title || ('Часть ' + (idx + 1)));
          if (!name) name = item.title || '';

          extract[idx + 1] = {
            file:           picked.url,
            translation:    name,
            quality:        picked.quality,
            qualities:      qq.qarr,
            qualities_map:  qq.qmap
          };
        });
      }
    }

    /* ---------- получить URL по выбранному элементу + предпочтительному качеству ---------- */

    function getFile(element, max_quality) {
      var translat = extract[element.translation];
      var file     = '';
      var quality  = false;

      if (translat) {
        if (element.season) {
          for (var i in translat.json) {
            var elem = translat.json[i];
            if (elem.folder) {
              for (var f in elem.folder) {
                var folder = elem.folder[f];
                if (folder.id == (element.season + '_' + element.episode)) {
                  file    = folder.file;
                  quality = folder.qualities_map || false;
                  break;
                }
              }
            }
          }
        } else {
          file    = translat.file;
          quality = translat.qualities_map || false;
        }
      }

      // НЕ подменяем file на quality[preferred]: file у нас — HLS (быстрый
      // старт), а qmap может быть HTTP-вариантом для master-HLS-сценария.
      // Подмена на HTTP убивает скорость старта (как в v1.4.3). Плеер сам
      // переключится на нужное качество, если пользователь его выберет.
      return { file: file, quality: quality || false };
    }

    /* ---------- список фильтров (сезон, озвучка) ---------- */

    function filter() {
      filter_items = {
        season:     [],
        voice:      [],
        voice_info: []
      };

      if (results.seasons && results.seasons.length) {
        var sortedSeasons = sortSeasonsForDisplay(results.seasons);
        var tmdbCounts    = (results.__tmdb_counts) || {};
        var hasSpecials   = false;
        sortedSeasons.forEach(function(s) {
          var num = parseInt(s.number) || 0;
          if (num === 0) { hasSpecials = true; return; }
          filter_items.season.push(Lampa.Lang.translate('torrent_serial_season') + ' ' + num);
          var tmdbMax = tmdbCounts[num];
          if (tmdbMax != null) {
            var anyOver = (s.episodes || []).some(function(ep) { return ep.number > tmdbMax; });
            if (anyOver) hasSpecials = true;
          }
        });
        if (hasSpecials) filter_items.season.push(Lampa.Lang.translate('online_specials'));

        // Озвучку для сериалов в сайдбар не выводим — выбор живёт ИСКЛЮЧИТЕЛЬНО
        // в OSD плеера (kinopub отдаёт один MKV/HLS со всеми треками внутри).
        // Изменения юзера в плеере перехватываются Hls.Events.AUDIO_TRACK_SWITCHED
        // → saveKinopubVoice → cache. Следующая серия / новая сессия применяют
        // тот же выбор автоматически через applyKinopubVoice.
      } else if (results.videos && results.videos.length) {
        for (var transl_id in extract) {
          var name = extract[transl_id].translation || '';
          if (name && filter_items.voice.indexOf(name) === -1) {
            filter_items.voice.push(name);
            filter_items.voice_info.push({ id: parseInt(transl_id) });
          }
        }
      }

      if (choice.voice_name) {
        var inx = filter_items.voice.map(function(v) { return v.toLowerCase(); }).indexOf(choice.voice_name.toLowerCase());
        if (inx === -1) choice.voice = 0;
        else if (inx !== choice.voice) choice.voice = inx;
      }

      component.filter(filter_items, choice);
    }

    /* ---------- плоский список под текущий выбор фильтра ---------- */

    function filtred() {
      var out = [];

      if (results && results.seasons && results.seasons.length) {
        // Озвучка живёт в choice (saved через saveKinopubVoice из плеера).
        // Если ничего не сохранено — пустые поля → applyKinopubVoice no-op,
        // плеер играет свою дефолтную дорожку.
        var voiceLang   = choice.voice_lang   || '';
        var voiceAuthor = choice.voice_author || '';
        var voiceType   = choice.voice_type   || '';
        var voiceLabel  = choice.voice_name   || '';
        var element = extract[1];
        if (element && element.json) {
          for (var si in element.json) {
            var ep = element.json[si];
            if (ep.id == choice.season + 1) {
              // Pre-pass: если строгое сравнение (lang+author/type) ни с одной
              // серией не сходится (бывает когда сохранили track.name из hls,
              // а в API kinopub автор/тип называются иначе) — фоллбэчимся на
              // проверку только по lang. Это лучше чем красить весь сезон.
              var anyStrict = false;
              if (voiceLang || voiceAuthor || voiceType) {
                anyStrict = ep.folder.some(function(m) {
                  return (m.audios || []).some(function(a) {
                    return audioMatches(a, voiceLang, voiceAuthor, voiceType);
                  });
                });
              }
              var matchLangOnly = !anyStrict && voiceLang;

              ep.folder.forEach(function(media) {
                var hasVoice = !voiceLang && !voiceAuthor && !voiceType;
                if (!hasVoice) {
                  hasVoice = (media.audios || []).some(function(a) {
                    return matchLangOnly
                      ? audioMatches(a, voiceLang, '', '')
                      : audioMatches(a, voiceLang, voiceAuthor, voiceType);
                  });
                }
                // Если выбора нет — подпись пустая.
                // Если выбор есть и совпадает — приглушённый зелёный.
                // Если выбор есть, но дорожки в серии нет — приглушённый розово-красный.
                var voiceHtml = '';
                if (voiceLabel) {
                  voiceHtml = hasVoice
                    ? '<span style="opacity:.85;color:#7adb7e">' + voiceLabel + '</span>'
                    : '<span style="opacity:.55;color:#ff6e58">' + voiceLabel + '</span>';
                }
                out.push({
                  episode:       parseInt(media.episode),
                  season:        media.season,
                  title:         Lampa.Lang.translate('torrent_serial_episode') + ' ' + media.episode + (media.title ? ' — ' + media.title : ''),
                  quality:       media.quality + 'p ',
                  qualitys:      media.qualities_map,
                  translation:   media.translation,
                  voice_name:    voiceLabel,
                  voice_lang:    voiceLang,
                  voice_author:  voiceAuthor,
                  voice_index:   0,
                  voice_missing: !hasVoice && !!voiceLabel,
                  audios:        media.audios || [],
                  info:          voiceHtml
                });
              });
              break;
            }
          }
        }
      }
      else if (results && results.videos && results.videos.length) {
        for (var tid in extract) {
          var v = extract[tid];
          out.push({
            title:       v.translation,
            quality:     v.quality + 'p ',
            qualitys:    v.qualities_map,
            qualities:   v.qualities,
            translation: parseInt(tid),
            voice_name:  v.translation
          });
        }
      }

      return out;
    }

    function toPlayElement(element) {
      var extra = getFile(element, element.quality);
      var play = {
        title:    element.title,
        url:      extra.file,
        quality:  extra.quality,
        timeline: element.timeline,
        callback: element.mark
      };
      // Метаданные выбранной озвучки. Их подхватит глобальный
      // 'player' listener и переключит дорожку через hls.js / video.audioTracks.
      if (element.voice_lang)            play.kp_voice_lang   = element.voice_lang;
      if (element.voice_author)          play.kp_voice_author = element.voice_author;
      if (element.voice_index != null)   play.kp_voice_index  = element.voice_index;
      if (element.voice_name)            play.kp_voice_name   = element.voice_name;
      // Сохраняем «глобально» — listener возьмёт это значение даже когда
      // плеер переключится на след. серию из плейлиста.
      window.__kp_pending_voice = {
        lang:   element.voice_lang   || '',
        author: element.voice_author || '',
        index:  (element.voice_index != null ? element.voice_index : 0),
        name:   element.voice_name   || ''
      };
      return play;
    }

    function append(items) {
      component.reset();
      component.draw(items, {
        similars: wait_similars,
        onEnter: function(item, html) {
          var extra = getFile(item, item.quality);
          if (extra.file) {
            // Запоминаем item_id и audios текущей серии — listener
            // AUDIO_TRACK_SWITCHED по ним поймёт какую озвучку юзер выбрал
            // на стороне kinopub-API (а не голый track.name из hls).
            try {
              window.__kp_current_item_id = object.movie.id;
              window.__kp_current_audios  = item.audios || [];
            } catch (er) {}
            var playlist = [];
            var first    = toPlayElement(item);
            if (item.season) items.forEach(function(elem) { playlist.push(toPlayElement(elem)); });
            else playlist.push(first);
            if (playlist.length > 1) first.playlist = playlist;
            Lampa.Player.play(first);
            Lampa.Player.playlist(playlist);
            item.mark();
          } else Lampa.Noty.show(Lampa.Lang.translate('online_nolink'));
        },
        onContextMenu: function(item, html, data, call) {
          call(getFile(item, item.quality));
        }
      });
    }
  }

  /* ==========================================================
   *                       КОМПОНЕНТ
   * ========================================================== */

  function component(object) {
    console.log('[kp2] component(): constructor called', {
      title: object && object.title,
      search: object && object.search,
      movie_id: object && object.movie && object.movie.id
    });
    var network = new Lampa.Reguest();
    var scroll  = new Lampa.Scroll({ mask: true, over: true });
    var files   = new Lampa.Explorer(object);
    var filter  = new Lampa.Filter(object);
    var sources = { kp2: kpapi };
    var last;
    var extended;
    var selected_id;
    var source;
    var balanser = 'kp2';
    var initialized;
    var balanser_timer;
    var images = [];
    var filter_translate = {
      season: Lampa.Lang.translate('torrent_serial_season'),
      voice:  Lampa.Lang.translate('torrent_parser_voice'),
      source: Lampa.Lang.translate('settings_rest_source')
    };

    this.initialize = function() {
      var _this = this;
      source = this.createSource();

      filter.onSearch = function(value) {
        Lampa.Activity.replace({ search: value, clarification: true });
      };
      filter.onBack = function() { _this.start(); };
      filter.render().find('.selector').on('hover:enter', function() {
        clearInterval(balanser_timer);
      });
      filter.onSelect = function(type, a, b) {
        if (type == 'filter') {
          if (a.reset) {
            if (extended) source.reset();
            else _this.start();
          } else {
            source.filter(type, a, b);
          }
        } else if (type == 'sort') {
          Lampa.Select.close();
        }
      };
      if (filter.addButtonBack) filter.addButtonBack();
      filter.render().find('.filter--sort').remove();

      files.appendFiles(scroll.render());
      files.appendHead(filter.render());
      scroll.body().addClass('torrent-list');
      scroll.minus(files.render().find('.explorer__files-head'));

      this.search();
    };

    this.createSource = function() { return new sources[balanser](this, object); };

    this.create = function() { return this.render(); };

    this.search = function() {
      this.activity.loader(true);
      this.find();
    };

    this.find = function() {
      if (source.searchByTitle) {
        this.extendChoice();
        source.searchByTitle(
          object,
          object.search || object.movie.original_title || object.movie.original_name || object.movie.title || object.movie.name
        );
      }
    };

    this.getChoice = function(for_balanser) {
      var data = Lampa.Storage.cache('online_choice_' + (for_balanser || balanser), 3000, {});
      var save = data[selected_id || object.movie.id] || {};
      Lampa.Arrays.extend(save, {
        season: 0, voice: 0, voice_name: '', voice_id: 0,
        episodes_view: {}, movie_view: ''
      });
      return save;
    };

    this.extendChoice = function() {
      extended = true;
      source.extendChoice(this.getChoice());
    };

    this.saveChoice = function(choice, for_balanser) {
      var data = Lampa.Storage.cache('online_choice_' + (for_balanser || balanser), 3000, {});
      data[selected_id || object.movie.id] = choice;
      Lampa.Storage.set('online_choice_' + (for_balanser || balanser), data);
    };

    this.similars = function(json) {
      var _this3 = this;
      json.forEach(function(elem) {
        var info = [];
        var year = ((elem.start_date || elem.year || '') + '').slice(0, 4);
        if (elem.rating && elem.rating !== 'null') info.push(Lampa.Template.get('online_prestige_rate', { rate: elem.rating }, true));
        if (year) info.push(year);
        if (elem.countries  && elem.countries.length)  info.push(elem.countries.join(', '));
        if (elem.categories && elem.categories.length) info.push(elem.categories.slice(0, 4).join(', '));

        var name = elem.title;
        var orig = elem.original_title || '';
        elem.title = name + (orig && orig !== name ? ' / ' + orig : '');
        elem.time  = '';
        elem.info  = info.join('<span class="online-prestige-split">●</span>');

        var item = Lampa.Template.get('online_prestige_folder', elem);
        item.on('hover:enter', function() {
          _this3.activity.loader(true);
          _this3.reset();
          object.search_date = year;
          selected_id = elem.id;
          _this3.extendChoice();
          if (source.search) source.search(object, [elem]);
          else _this3.doesNotAnswer();
        }).on('hover:focus', function(e) {
          last = e.target;
          scroll.update($(e.target), true);
        });
        scroll.append(item);
      });
    };

    this.clearImages = function() {
      images.forEach(function(img) { img.onerror = function(){}; img.onload = function(){}; img.src = ''; });
      images = [];
    };

    this.reset = function() {
      last = false;
      clearInterval(balanser_timer);
      network.clear();
      this.clearImages();
      scroll.render().find('.empty').remove();
      scroll.clear();
    };

    this.loading = function(status) {
      if (status) this.activity.loader(true);
      else { this.activity.loader(false); this.activity.toggle(); }
    };

    this.filter = function(filter_items, choice) {
      var _this4 = this;
      var select = [];
      var add = function(type, title) {
        var need = _this4.getChoice();
        var items = filter_items[type];
        var subitems = [];
        var value = need[type];
        items.forEach(function(name, i) {
          subitems.push({ title: name, selected: value == i, index: i });
        });
        select.push({ title: title, subtitle: items[value], items: subitems, stype: type });
      };
      select.push({ title: Lampa.Lang.translate('torrent_parser_reset'), reset: true });
      this.saveChoice(choice);
      if (filter_items.voice  && filter_items.voice.length)  add('voice',  Lampa.Lang.translate('torrent_parser_voice'));
      if (filter_items.season && filter_items.season.length) add('season', Lampa.Lang.translate('torrent_serial_season'));
      filter.set('filter', select);
      this.selected(filter_items);
    };

    this.closeFilter = function() {
      if ($('body').hasClass('selectbox--open')) Lampa.Select.close();
    };

    this.selected = function(filter_items) {
      var need = this.getChoice(), select = [];
      for (var i in need) {
        if (filter_items[i] && filter_items[i].length) {
          if (i == 'voice') select.push(filter_translate[i] + ': ' + filter_items[i][need[i]]);
          else if (i !== 'source') {
            if (filter_items.season.length >= 1) select.push(filter_translate.season + ': ' + filter_items[i][need[i]]);
          }
        }
      }
      filter.chosen('filter', select);
      filter.chosen('sort', [balanser]);
    };

    this.getEpisodes = function(season, call) {
      var episodes = [];
      if (typeof object.movie.id == 'number' && object.movie.name) {
        var tmdburl = 'tv/' + object.movie.id + '/season/' + season + '?api_key=' + Lampa.TMDB.key() + '&language=' + Lampa.Storage.get('language', 'ru');
        var baseurl = Lampa.TMDB.api(tmdburl);
        network.timeout(1000 * 10);
        network["native"](baseurl, function(data) { episodes = data.episodes || []; call(episodes); }, function() { call(episodes); });
      } else call(episodes);
    };

    this.append = function(item) {
      item.on('hover:focus', function(e) { last = e.target; scroll.update($(e.target), true); });
      scroll.append(item);
    };

    this.watched = function(set) {
      var file_id = Lampa.Utils.hash(object.movie.number_of_seasons ? object.movie.original_name : object.movie.original_title);
      var watched = Lampa.Storage.cache('online_watched_last', 5000, {});
      if (set) {
        if (!watched[file_id]) watched[file_id] = {};
        Lampa.Arrays.extend(watched[file_id], set, true);
        Lampa.Storage.set('online_watched_last', watched);
      } else return watched[file_id];
    };

    this.draw = function(items) {
      var _this5 = this;
      var params = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
      if (!items.length) return this.empty();

      this.getEpisodes(items[0].season, function(episodes) {
        var viewed  = Lampa.Storage.cache('online_view', 5000, []);
        var serial  = object.movie.name ? true : false;
        var choice  = _this5.getChoice();
        var fully   = window.innerWidth > 480;
        var scroll_to_element = false;
        var scroll_to_mark    = false;

        items.forEach(function(element, index) {
          var episode      = serial && episodes.length && !params.similars
                              ? episodes.find(function(e) { return e.episode_number == element.episode; })
                              : false;
          var episode_num  = element.episode || index + 1;
          var episode_last = choice.episodes_view[element.season];

          Lampa.Arrays.extend(element, {
            info:    '',
            quality: '',
            time:    Lampa.Utils.secondsToTime((episode ? episode.runtime : object.movie.runtime) * 60, true)
          });

          var hash_timeline = Lampa.Utils.hash(element.season ? [element.season, element.episode, object.movie.original_title].join('') : object.movie.original_title);
          var hash_behold   = Lampa.Utils.hash(element.season ? [element.season, element.episode, object.movie.original_title, element.voice_name].join('') : object.movie.original_title + element.voice_name);
          var data = { hash_timeline: hash_timeline, hash_behold: hash_behold };
          var info = [];

          if (element.season) {
            element.translate_episode_end = _this5.getLastEpisode(items);
            element.translate_voice       = element.voice_name;
          }
          element.timeline = Lampa.Timeline.view(hash_timeline);

          if (episode) {
            element.title = episode.name;
            if (element.info.length < 30 && episode.vote_average)
              info.push(Lampa.Template.get('online_prestige_rate', { rate: parseFloat(episode.vote_average + '').toFixed(1) }, true));
            if (episode.air_date && fully) info.push(Lampa.Utils.parseTime(episode.air_date).full);
          } else if (object.movie.release_date && fully) {
            info.push(Lampa.Utils.parseTime(object.movie.release_date).full);
          }

          if (!serial && object.movie.tagline && element.info.length < 30) info.push(object.movie.tagline);
          if (element.info) info.push(element.info);
          if (info.length) element.info = info.map(function(i) { return '<span>' + i + '</span>'; }).join('<span class="online-prestige-split">●</span>');

          var html   = Lampa.Template.get('online_prestige_full', element);
          var loader = html.find('.online-prestige__loader');
          var image  = html.find('.online-prestige__img');

          if (!serial) {
            if (choice.movie_view == hash_behold) scroll_to_element = html;
          } else if (typeof episode_last !== 'undefined' && episode_last == episode_num) {
            scroll_to_element = html;
          }

          if (serial && !episode) {
            image.append('<div class="online-prestige__episode-number">' + ('0' + (element.episode || index + 1)).slice(-2) + '</div>');
            loader.remove();
          } else {
            var img = html.find('img')[0];
            img.onerror = function() { img.src = './img/img_broken.svg'; };
            img.onload  = function() {
              image.addClass('online-prestige__img--loaded');
              loader.remove();
              if (serial) image.append('<div class="online-prestige__episode-number">' + ('0' + (element.episode || index + 1)).slice(-2) + '</div>');
            };
            img.src = Lampa.TMDB.image('t/p/w300' + (episode ? episode.still_path : object.movie.backdrop_path));
            images.push(img);
          }

          html.find('.online-prestige__timeline').append(Lampa.Timeline.render(element.timeline));

          if (viewed.indexOf(hash_behold) !== -1) {
            scroll_to_mark = html;
            html.find('.online-prestige__img').append('<div class="online-prestige__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
          }

          element.mark = function() {
            viewed = Lampa.Storage.cache('online_view', 5000, []);
            if (viewed.indexOf(hash_behold) == -1) {
              viewed.push(hash_behold);
              Lampa.Storage.set('online_view', viewed);
              if (html.find('.online-prestige__viewed').length == 0)
                html.find('.online-prestige__img').append('<div class="online-prestige__viewed">' + Lampa.Template.get('icon_viewed', {}, true) + '</div>');
            }
            choice = _this5.getChoice();
            if (!serial) choice.movie_view = hash_behold;
            else         choice.episodes_view[element.season] = episode_num;
            _this5.saveChoice(choice);
          };

          element.unmark = function() {
            viewed = Lampa.Storage.cache('online_view', 5000, []);
            if (viewed.indexOf(hash_behold) !== -1) {
              Lampa.Arrays.remove(viewed, hash_behold);
              Lampa.Storage.set('online_view', viewed);
              html.find('.online-prestige__viewed').remove();
            }
          };

          element.timeclear = function() {
            element.timeline.percent = 0;
            element.timeline.time = 0;
            element.timeline.duration = 0;
            Lampa.Timeline.update(element.timeline);
          };

          html.on('hover:enter', function() {
            if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
            if (params.onEnter) params.onEnter(element, html, data);
          }).on('hover:focus', function(e) {
            last = e.target;
            if (params.onFocus) params.onFocus(element, html, data);
            scroll.update($(e.target), true);
          });

          _this5.contextMenu({
            html: html,
            element: element,
            onFile: function(call) { if (params.onContextMenu) params.onContextMenu(element, html, data, call); },
            onClearAllMark: function() { items.forEach(function(elem) { elem.unmark(); }); },
            onClearAllTime: function() { items.forEach(function(elem) { elem.timeclear(); }); }
          });

          scroll.append(html);
        });

        if (scroll_to_element) last = scroll_to_element[0];
        else if (scroll_to_mark) last = scroll_to_mark[0];
        Lampa.Controller.enable('content');
      });
    };

    this.contextMenu = function(params) {
      params.html.on('hover:long', function() {
        function show(extra) {
          var enabled = Lampa.Controller.enabled().name;
          var menu = [];
          if (Lampa.Platform.is('webos'))   menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Webos',   player: 'webos' });
          if (Lampa.Platform.is('android')) menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Android', player: 'android' });
          menu.push({ title: Lampa.Lang.translate('player_lauch') + ' - Lampa', player: 'lampa' });
          menu.push({ title: Lampa.Lang.translate('online_video'),                  separator: true });
          menu.push({ title: Lampa.Lang.translate('torrent_parser_label_title'),    mark: true });
          menu.push({ title: Lampa.Lang.translate('torrent_parser_label_cancel_title'), unmark: true });
          menu.push({ title: Lampa.Lang.translate('time_reset'),                    timeclear: true });
          if (extra) menu.push({ title: Lampa.Lang.translate('copy_link'),          copylink: true });
          menu.push({ title: Lampa.Lang.translate('online_clear_all_marks'),        clearallmark: true });
          menu.push({ title: Lampa.Lang.translate('online_clear_all_timecodes'),    timeclearall: true });
          Lampa.Select.show({
            title: Lampa.Lang.translate('title_action'),
            items: menu,
            onBack: function() { Lampa.Controller.toggle(enabled); },
            onSelect: function(a) {
              if (a.mark)         params.element.mark();
              if (a.unmark)       params.element.unmark();
              if (a.timeclear)    params.element.timeclear();
              if (a.clearallmark) params.onClearAllMark();
              if (a.timeclearall) params.onClearAllTime();
              Lampa.Controller.toggle(enabled);
              if (a.player) { Lampa.Player.runas(a.player); params.html.trigger('hover:enter'); }
              if (a.copylink) {
                if (extra.quality) {
                  var qual = [];
                  for (var i in extra.quality) qual.push({ title: i, file: extra.quality[i] });
                  Lampa.Select.show({
                    title: Lampa.Lang.translate('settings_server_links'),
                    items: qual,
                    onBack: function() { Lampa.Controller.toggle(enabled); },
                    onSelect: function(b) {
                      Lampa.Utils.copyTextToClipboard(b.file,
                        function() { Lampa.Noty.show(Lampa.Lang.translate('copy_secuses')); },
                        function() { Lampa.Noty.show(Lampa.Lang.translate('copy_error')); });
                    }
                  });
                } else {
                  Lampa.Utils.copyTextToClipboard(extra.file,
                    function() { Lampa.Noty.show(Lampa.Lang.translate('copy_secuses')); },
                    function() { Lampa.Noty.show(Lampa.Lang.translate('copy_error')); });
                }
              }
            }
          });
        }
        params.onFile(show);
      }).on('hover:focus', function() {
        if (Lampa.Helper) Lampa.Helper.show('online_file', Lampa.Lang.translate('helper_online_file'), params.html);
      });
    };

    this.empty = function() {
      var html = Lampa.Template.get('online_does_not_answer', {});
      html.find('.online-empty__buttons').remove();
      html.find('.online-empty__title').text(Lampa.Lang.translate('empty_title_two'));
      scroll.append(html);
      this.loading(false);
    };

    this.doesNotAnswer = function() {
      this.reset();
      var html = Lampa.Template.get('online_does_not_answer', { balanser: balanser });
      scroll.append(html);
      this.loading(false);
    };

    this.getLastEpisode = function(items) {
      var last_episode = 0;
      items.forEach(function(e) { if (typeof e.episode !== 'undefined') last_episode = Math.max(last_episode, parseInt(e.episode)); });
      return last_episode;
    };

    this.start = function() {
      if (Lampa.Activity.active().activity !== this.activity) return;
      if (!initialized) { initialized = true; this.initialize(); }
      // ВАЖНО: не зовём source.refresh() из start() — append → draw → empty →
      // loading(false) → activity.toggle() → start() = бесконечный цикл,
      // если filtred() вдруг возвращает пустой список (например при
      // временно повреждённом cache). Refresh подписей сейчас работает
      // только через перезаход в карточку — это безопаснее.
      Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));
      Lampa.Controller.add('content', {
        toggle: function() {
          Lampa.Controller.collectionSet(scroll.render(), files.render());
          Lampa.Controller.collectionFocus(last || false, scroll.render());
        },
        up:    function() { if (Navigator.canmove('up'))    Navigator.move('up');    else Lampa.Controller.toggle('head'); },
        down:  function() { Navigator.move('down'); },
        right: function() { if (Navigator.canmove('right')) Navigator.move('right'); else filter.show(Lampa.Lang.translate('title_filter'), 'filter'); },
        left:  function() { if (Navigator.canmove('left'))  Navigator.move('left');  else Lampa.Controller.toggle('menu'); },
        back:  this.back
      });
      Lampa.Controller.toggle('content');
    };

    this.render  = function() { return files.render(); };
    this.back    = function() { Lampa.Activity.backward(); };
    this.pause   = function() {};
    this.stop    = function() {};
    this.destroy = function() {
      network.clear();
      this.clearImages();
      files.destroy();
      scroll.destroy();
      if (source && source.destroy) source.destroy();
      // если активити закрыли в момент device-flow — прибиваем модалку и поллинг
      if (modalopen) { modalopen = false; try { Lampa.Modal.close(); } catch (e) {} }
      clearInterval(ping_auth);
    };
  }

  /* ==========================================================
   *                       startPlugin
   * ========================================================== */

  /* ==========================================================
   *      AUDIO TRACK SWITCH (через hls.js / video.audioTracks)
   * ========================================================== */

  // Языки приходят неконсистентно: kinopub-API даёт «rus», hls.js может
  // отдать «ru». Сравниваем lowercase + startsWith в обе стороны.
  function langEq(a, b) {
    if (!a || !b) return false;
    a = (a + '').toLowerCase(); b = (b + '').toLowerCase();
    if (a === b) return true;
    if (a.length > 1 && b.length > 1 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)) return true;
    return false;
  }
  // Имя автора перевода — substring match, case-insensitive.
  function authorEq(a, b) {
    if (!a || !b) return false;
    a = (a + '').toLowerCase(); b = (b + '').toLowerCase();
    return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  }

  // Подбираем индекс аудио-трека под сохранённую озвучку.
  // Сначала ищем lang+author, потом только lang, потом по индексу.
  function findAudioTrackIdx(tracks, voice) {
    if (!tracks || !tracks.length || !voice) return -1;
    function tLang(t)  { return t.lang  || t.language || ''; }
    function tLabel(t) { return t.name  || t.label    || ''; }

    if (voice.lang && voice.author) {
      for (var i = 0; i < tracks.length; i++) {
        if (langEq(tLang(tracks[i]), voice.lang) && authorEq(tLabel(tracks[i]), voice.author)) return i;
      }
    }
    if (voice.lang) {
      for (var j = 0; j < tracks.length; j++) {
        if (langEq(tLang(tracks[j]), voice.lang)) return j;
      }
    }
    if (typeof voice.index === 'number' && voice.index >= 0 && voice.index < tracks.length) {
      return voice.index;
    }
    return -1;
  }

  // Совпадает ли запись episode.audios с сохранённым выбором.
  // Если есть точный kp-side {author, type} (saveKinopubVoice сохранил
  // их из window.__kp_current_audios) — сравниваем поля «как есть».
  // Если есть только author из hls track.name — fuzzy substring match
  // против комбинаций author/type/their concat.
  function audioMatches(audio, voiceLang, voiceAuthor, voiceType) {
    if (!voiceLang && !voiceAuthor && !voiceType) return true;
    if (voiceLang && !langEq(audio.lang || '', voiceLang)) return false;
    // Если у нас в воиc есть точный kinopub type и author — строгий матч
    if (voiceType) {
      var aA = audio.author || '';
      var aT = audio.type   || '';
      var typeOk   = !voiceType   || authorEq(aT, voiceType);
      var authorOk = !voiceAuthor || authorEq(aA, voiceAuthor);
      // Оба строго: type и author (если оба заданы)
      if (!typeOk) return false;
      if (voiceAuthor && !authorOk) return false;
      return true;
    }
    // Иначе fuzzy против комбинаций
    if (voiceAuthor) {
      var a = audio.author || '';
      var t = audio.type   || '';
      var combos = [a, t];
      if (a && t) {
        combos.push(a + ' ' + t);
        combos.push(a + ' • ' + t);
        combos.push(t + ' ' + a);
      }
      var matched = combos.some(function(s) { return s && authorEq(s, voiceAuthor); });
      if (!matched) return false;
    }
    return true;
  }

  /**
   * Сохранить выбранную пользователем озвучку в Lampa.Storage кэш.
   * Вызывается из AUDIO_TRACK_SWITCHED. Если у нас в памяти есть аудиолист
   * текущей серии (window.__kp_current_audios — выставляется в onEnter), мы
   * берём НАСТОЯЩИЕ kinopub-поля {lang, author, type} — это даёт точный
   * матчинг при пометке остальных серий. track.name из hls.js часто пустой
   * или нестандартный, ему доверяем во вторую очередь.
   */
  function saveKinopubVoice(track, kpAudio) {
    if (!track && !kpAudio) return;
    var t = track || {};
    var k = kpAudio || {};
    var voice = {
      lang:   k.lang   || t.lang  || t.language || '',
      author: k.author || t.name  || t.label    || '',
      type:   k.type   || '',
      // Display label: предпочитаем то что показывает плеер (track.name).
      // Если он пустой — собираем из kp-полей.
      name:   (t.name || t.label) || (k.author ? k.author + (k.type ? ' • ' + k.type : '') : (k.type || ''))
    };
    window.__kp_pending_voice = voice;

    var item_id = window.__kp_current_item_id;
    if (!item_id) return;
    try {
      var key  = 'online_choice_kp2';
      var data = Lampa.Storage.cache(key, 3000, {});
      // Чистим этот item_id от любого мусора — пишем только примитивы.
      data[item_id] = {
        season:        (data[item_id] && typeof data[item_id].season       === 'number') ? data[item_id].season       : 0,
        voice:         (data[item_id] && typeof data[item_id].voice        === 'number') ? data[item_id].voice        : 0,
        voice_id:      (data[item_id] && typeof data[item_id].voice_id     === 'number') ? data[item_id].voice_id     : 0,
        episodes_view: (data[item_id] && data[item_id].episodes_view && typeof data[item_id].episodes_view === 'object')
                       ? JSON.parse(JSON.stringify(data[item_id].episodes_view)) : {},
        movie_view:    (data[item_id] && typeof data[item_id].movie_view   === 'string') ? data[item_id].movie_view   : '',
        voice_lang:    voice.lang,
        voice_author:  voice.author,
        voice_type:    voice.type,
        voice_name:    voice.name
      };
      // Защита от циклов в ОСТАЛЬНЫХ item_id (если sanitize по какой-то
      // причине не успел или они снова появились) — round-trip всё.
      var clean;
      try { clean = JSON.parse(JSON.stringify(data)); }
      catch (cycleErr) {
        clean = {}; clean[item_id] = data[item_id]; // fallback: только текущий
      }
      Lampa.Storage.set(key, clean);
    } catch (e) {}
  }

  function applyKinopubVoice() {
    var voice = window.__kp_pending_voice;
    // Если ни lang ни author не заданы — НЕ трогаем плеер. Иначе уйдём в
    // index-фоллбэк и принудительно поставим первый трек, перебив дефолт
    // плеера. (Это и был баг: после reopen карточки без сохранённой озвучки
    // мы били в track 0.)
    if (!voice || (!voice.lang && !voice.author)) return;

    // hls-инстанс может лежать в трёх разных местах в зависимости от того,
    // успел ли отработать наш monkey-patch и как Lampa подхватила Hls.
    var hls = window.__kp_hls || window.hls || null;
    if (hls && hls.audioTracks && hls.audioTracks.length) {
      try {
        var idx = findAudioTrackIdx(hls.audioTracks, voice);
        if (idx >= 0 && idx !== hls.audioTrack) {
          hls.audioTrack = idx;
        }
        return;
      } catch (e) {}
    }
    // Native <video>.audioTracks — для случаев когда плеер играет НЕ через
    // hls.js (mp4 fallback или MKV напрямую).
    try {
      var v = document.querySelector('video');
      if (v && v.audioTracks && v.audioTracks.length) {
        var nIdx = findAudioTrackIdx(v.audioTracks, voice);
        if (nIdx >= 0) {
          for (var k = 0; k < v.audioTracks.length; k++) {
            v.audioTracks[k].enabled = (k === nIdx);
          }
        }
      }
    } catch (e) {}
  }

  /**
   * Lampa не выставляет hls-инстанс наружу (window.hls = undefined).
   * Поэтому monkey-patch'им конструктор Hls: каждый раз когда Lampa делает
   * new Hls(config), наша обёртка пишет инстанс в window.__kp_hls и
   * подписывается на AUDIO_TRACKS_UPDATED — чтобы применить выбранную
   * пользователем озвучку, как только hls.js распарсит мастер-плейлист.
   */
  function ensurePatchHls() {
    // window.Hls появляется только после того как Lampa подгрузит ./vender/hls/hls.js,
    // а это происходит уже ПОСЛЕ нашего startPlugin. Поэтому ждём в фоне.
    if (window.Hls) patchHls();

    // Watcher на смену window.Hls (Lampa/bwa подменяют 1.1.2 → 1.4.7 на лету,
    // см. v2.0.8). Каждые 500 мс проверяем, остался ли прототип запатченным —
    // если нет (новый класс), повторно патчим. Это страховка для прототипного
    // hook'а; Proxy на конструктор патчим только один раз (window.Hls могут
    // оборачивать несколько раз, перенакручивать наш Proxy не будем).
    if (window.__kp_hls_watcher) return;
    window.__kp_hls_watcher = true;
    var watcherTries = 0;
    setInterval(function() {
      try {
        if (window.Hls && window.Hls.prototype && !window.Hls.prototype.__kp_proto_patched) {
          console.log('[kp2] Hls swap detected, re-patching prototype', {
            version: window.Hls.version
          });
          patchHlsPrototype();
        }
      } catch (e) {}
      if (++watcherTries > 600) {} // не выключаем — пусть работает всю сессию (~5 мин минимум)
    }, 500);
  }

  /**
   * На Tizen Lampa захватывает window.Hls раньше нашего Proxy-патча, так что
   * Proxy на конструктор не срабатывает (window.__kp_hls остаётся пустым).
   * Прототипное патчирование решает это: Hls.prototype.attachMedia — один
   * объект для ВСЕХ ссылок на класс (хоть кэшированных, хоть свежих),
   * и new Hls() обязательно проходит через него. Этим способом мы ловим
   * ЛЮБОЙ инстанс независимо от того, кто и когда его создал.
   */
  function patchHlsPrototype() {
    if (!window.Hls || !window.Hls.prototype || !window.Hls.prototype.attachMedia) {
      console.log('[kp2] proto-patch: no Hls/proto/attachMedia, skip');
      return;
    }
    // Per-prototype флаг! Lampa/bwa подменяют window.Hls на лету (1.1.2 → 1.4.7),
    // и каждый новый прототип нужно патчить отдельно. Глобальный флаг здесь не подходит.
    var proto = window.Hls.prototype;
    if (proto.__kp_proto_patched) return;

    console.log('[kp2] patchHlsPrototype: applying', {
      Hls_version: window.Hls.version,
      proto_keys_count: Object.getOwnPropertyNames(proto).length
    });

    var origAttach = proto.attachMedia;
    proto.attachMedia = function(media) {
      var instance = this;
      window.__kp_hls = instance;
      try {
        console.log('[kp2] Hls.attachMedia intercepted (proto)', {
          v: window.Hls && window.Hls.version,
          tracks_n: instance.audioTracks && instance.audioTracks.length
        });
      } catch (e) {}
      try {
        var EV = window.Hls && window.Hls.Events;
        if (EV) {
          if (EV.AUDIO_TRACKS_UPDATED) {
            instance.on(EV.AUDIO_TRACKS_UPDATED, function() {
              try {
                console.log('[kp2] AUDIO_TRACKS_UPDATED (proto)', {
                  n: instance.audioTracks && instance.audioTracks.length
                });
              } catch (e) {}
              applyKinopubVoice();
            });
          }
          if (EV.MANIFEST_PARSED) {
            instance.on(EV.MANIFEST_PARSED, function() { setTimeout(applyKinopubVoice, 200); });
          }
          if (EV.AUDIO_TRACK_SWITCHED) {
            instance.on(EV.AUDIO_TRACK_SWITCHED, function() {
              try {
                var id = instance.audioTrack;
                var track = instance.audioTracks && instance.audioTracks[id];
                var kpAudio = window.__kp_current_audios && window.__kp_current_audios[id];
                console.log('[kp2] AUDIO_TRACK_SWITCHED (proto)', {
                  id: id,
                  track_lang: track && track.lang,
                  track_name: track && track.name,
                  kp_audio: kpAudio
                });
                if (track || kpAudio) saveKinopubVoice(track, kpAudio);
              } catch (e) {}
            });
          }
        }
      } catch (e) {
        try { console.log('[kp2] proto-hook err', String(e)); } catch (er) {}
      }
      return origAttach.apply(this, arguments);
    };
    proto.__kp_proto_patched = true;
    console.log('[kp2] Hls.prototype.attachMedia PATCHED', {
      version: window.Hls && window.Hls.version
    });
  }

  function patchHls() {
    if (window.__kp_hls_patched || !window.Hls) return;
    console.log('[kp2] patchHls(): wrapping window.Hls', {
      version: (window.Hls && window.Hls.version) || '?'
    });
    // Сначала прототипный фоллбек — он самый надёжный на Tizen.
    patchHlsPrototype();
    var Original = window.Hls;

    // Proxy прозрачно форвардит ВСЕ обращения к target — включая
    // non-enumerable статики (Hls.Events, Hls.ErrorTypes) и геттеры.
    // Простое копирование через for-in пропускает non-enumerable свойства,
    // и Lampa крашится на Hls.ErrorTypes.ERROR (=> Cannot read 'ERROR' of undefined).
    var Patched = new Proxy(Original, {
      construct: function(target, args) {
        var inst = Reflect.construct(target, args);
        window.__kp_hls = inst;
        console.log('[kp2] new Hls() intercepted, instance saved');
        try {
          var EV = target.Events;
          // Дорожки готовы → применяем сохранённую озвучку
          if (EV && EV.AUDIO_TRACKS_UPDATED) {
            inst.on(EV.AUDIO_TRACKS_UPDATED, function() { applyKinopubVoice(); });
          }
          if (EV && EV.MANIFEST_PARSED) {
            inst.on(EV.MANIFEST_PARSED, function() { setTimeout(applyKinopubVoice, 200); });
          }
          // Юзер сменил дорожку в OSD плеера → запоминаем для следующих серий.
          // hls.js разных версий зовёт колбэк (event, data) ИЛИ просто (data),
          // поэтому опираемся на inst.audioTrack — он уже выставлен в новый
          // индекс к моменту срабатывания события.
          if (EV && EV.AUDIO_TRACK_SWITCHED) {
            inst.on(EV.AUDIO_TRACK_SWITCHED, function() {
              try {
                var id = inst.audioTrack;
                var track = inst.audioTracks && inst.audioTracks[id];
                var kpAudio = window.__kp_current_audios && window.__kp_current_audios[id];
                console.log('[kp2] AUDIO_TRACK_SWITCHED', {
                  id: id,
                  track_lang: track && track.lang,
                  track_name: track && track.name,
                  kp_audio: kpAudio
                });
                if (track || kpAudio) saveKinopubVoice(track, kpAudio);
              } catch (e) {}
            });
          }
        } catch (e) {}
        return inst;
      }
    });
    window.Hls = Patched;
    window.__kp_hls_patched = true;
  }

  // Слушаем события плеера: на старт каждого нового стрима (новая серия,
  // переоткрытие, и т.п.) повторно применяем озвучку. Это страховка на случай
  // если monkey-patch был установлен ПОСЛЕ создания Hls-инстанса.
  /**
   * На Tizen наш Proxy на window.Hls срабатывает не всегда — Lampa захватывает
   * ссылку на конструктор раньше нашего patch'а (порядок загрузки модулей
   * отличается от десктопа). Поэтому страховочно ищем готовый инстанс через
   * известные места в самой Lampa и через DOM-video, и подцепляемся к нему
   * пост-фактум. Логируем всё, что нашли — это наш единственный способ узнать
   * структуру Lampa изнутри Tizen.
   */
  function probeAndHookHls(reason) {
    var hls = null;
    var found_via = '';
    var probes = [];

    function tryPath(name, fn) {
      try {
        var v = fn();
        var ok = !!v;
        probes.push(name + '=' + (ok ? 'present' : 'null'));
        if (ok && !hls) { hls = v; found_via = name; }
      } catch (e) {
        probes.push(name + '=throw');
      }
    }

    // Каждый probe — ещё и шанс запатчить прототип (если Hls появился позже).
    try { patchHlsPrototype(); } catch (e) {}

    tryPath('window.__kp_hls',          function() { return window.__kp_hls; });
    tryPath('Lampa.PlayerVideo.hls',    function() { return Lampa.PlayerVideo && Lampa.PlayerVideo.hls; });
    tryPath('Lampa.Player.hls',         function() { return Lampa.Player && Lampa.Player.hls; });
    tryPath('Lampa.Player.video.hls',   function() { return Lampa.Player && Lampa.Player.video && Lampa.Player.video.hls; });
    tryPath('Lampa.PlayerVideo.video.hls', function() { return Lampa.PlayerVideo && Lampa.PlayerVideo.video && Lampa.PlayerVideo.video.hls; });

    // Probe video element: hls.js часто вешает себя на video через wreflict,
    // sym-ключ или приватное _-свойство. Пройдёмся по всем ключам и найдём
    // объект с .audioTracks + .levels (характерный признак Hls instance).
    try {
      var vEl = document.querySelector('video');
      probes.push('video_el=' + (vEl ? 'present' : 'null'));
      if (vEl) {
        var keys = [];
        for (var k in vEl) {
          try {
            var val = vEl[k];
            if (val && typeof val === 'object'
              && Array.isArray(val.audioTracks)
              && Array.isArray(val.levels)) {
              keys.push(k);
              if (!hls) { hls = val; found_via = 'video.' + k; }
            }
          } catch (e) {}
        }
        if (keys.length) probes.push('video_keys=' + keys.join(','));
      }
    } catch (e) {}

    console.log('[kp2] hls probe (' + reason + ')', { found_via: found_via, probes: probes });

    // Если нашли — подцепляемся (только один раз на каждый инстанс).
    if (hls && !hls.__kp_hooked) {
      hls.__kp_hooked = true;
      try {
        var EV = (window.Hls && window.Hls.Events) || hls.constructor && hls.constructor.Events;
        if (!EV) { console.log('[kp2] no Hls.Events available, skip hook'); return; }
        if (EV.AUDIO_TRACKS_UPDATED) {
          hls.on(EV.AUDIO_TRACKS_UPDATED, function() {
            console.log('[kp2] AUDIO_TRACKS_UPDATED (probed)', {
              n: hls.audioTracks && hls.audioTracks.length
            });
            applyKinopubVoice();
          });
        }
        if (EV.MANIFEST_PARSED) {
          hls.on(EV.MANIFEST_PARSED, function() { setTimeout(applyKinopubVoice, 200); });
        }
        if (EV.AUDIO_TRACK_SWITCHED) {
          hls.on(EV.AUDIO_TRACK_SWITCHED, function() {
            try {
              var id = hls.audioTrack;
              var track = hls.audioTracks && hls.audioTracks[id];
              var kpAudio = window.__kp_current_audios && window.__kp_current_audios[id];
              console.log('[kp2] AUDIO_TRACK_SWITCHED (probed)', {
                id: id,
                track_lang: track && track.lang,
                track_name: track && track.name,
                kp_audio: kpAudio
              });
              if (track || kpAudio) saveKinopubVoice(track, kpAudio);
            } catch (e) {}
          });
        }
        console.log('[kp2] hls hooks attached via probe', { via: found_via });
      } catch (e) {
        console.log('[kp2] hook failed', String(e));
      }
    }
  }

  function bindPlayerListener() {
    if (window.__kp_player_listener) return;
    window.__kp_player_listener = true;

    var apply = function() {
      setTimeout(applyKinopubVoice,  600);
      setTimeout(applyKinopubVoice, 1500);
      setTimeout(applyKinopubVoice, 3000);
    };

    // Канал 1: глобальный Lampa.Listener
    try {
      Lampa.Listener.follow('player', function(e) {
        try { console.log('[kp2] player event', { type: e && e.type }); } catch (er) {}
        if (e && (e.type === 'start' || e.type === 'video' || e.type === 'change' || e.type === 'inited')) {
          apply();
          // probe + hook (несколько раз — hls может ещё не успеть появиться)
          setTimeout(function() { probeAndHookHls('player.' + e.type + '+200'); },  200);
          setTimeout(function() { probeAndHookHls('player.' + e.type + '+800'); },  800);
          setTimeout(function() { probeAndHookHls('player.' + e.type + '+2000'); }, 2000);
        }
      });
    } catch (e) {}

    // Канал 2: Lampa.Player.listener (отдельный Listener плеера)
    try {
      if (Lampa.Player && Lampa.Player.listener && Lampa.Player.listener.follow) {
        Lampa.Player.listener.follow('start', function() {
          apply();
          setTimeout(function() { probeAndHookHls('Lampa.Player.start+500'); }, 500);
        });
        Lampa.Player.listener.follow('video', function() {
          apply();
          setTimeout(function() { probeAndHookHls('Lampa.Player.video+500'); }, 500);
        });
      }
    } catch (e) {}
  }

  /**
   * Старые версии плагина (v1.4.13) ловили баг: deep-extend choice объекта
   * самим собой создавал самореференцию, и она попадала в Lampa.Storage.
   * После этого ЛЮБАЯ запись в этот ключ — JSON.stringify падает с RangeError.
   * Эта функция round-trip'ит каждую запись через JSON: то что не сериализуется
   * (= цикл) — отбрасывается. Один раз на старте плагина.
   */
  function sanitizeKpStorage() {
    try {
      var key   = 'online_choice_kp2';
      var data  = Lampa.Storage.get(key, {}) || {};
      var clean = {};
      var dropped = 0;
      for (var k in data) {
        if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
        try {
          clean[k] = JSON.parse(JSON.stringify(data[k]));
        } catch (e) {
          dropped++;
        }
      }
      if (dropped > 0) {
        try { console.warn('[kinopub] sanitized cache, dropped', dropped, 'cyclic entries'); } catch (e) {}
      }
      Lampa.Storage.set(key, clean);
    } catch (e) {}
  }

  /**
   * Лёгкая проверка токена при старте: дёргаем /v1/user. Если 401 и есть
   * refresh_token — apiSilent сам обновит и повторит. Если 401 без refresh —
   * стираем; следующий заход в карточку покажет device-flow.
   */
  function checkKpToken() {
    if (!kp_token) return;
    var net = new Lampa.Reguest();
    net.timeout(8000);
    apiSilent(net, api_url + 'user', function() {}, function() {});
  }

  function startPlugin() {
    console.log('[kp2] startPlugin: enter');
    window.online_kinopub2 = true;
    sanitizeKpStorage();  // one-time cleanup от циклов из старых сборок
    ensurePatchHls();     // дождаться window.Hls и подменить конструктор
    bindPlayerListener(); // страховка на повторное применение озвучки
    checkKpToken();       // обновить access_token если истёк

    var manifest = {
      type:        'video',
      version:     PLUGIN_VERSION,
      name:        'Онлайн - Kinopub 2 (TV)',
      description: 'Плагин для просмотра онлайн kino.pub',
      component:   'online_kinopub2',
      onContextMenu: function() {
        return { name: Lampa.Lang.translate('online_watch'), description: '' };
      },
      onContextLauch: function(object) {
        console.log('[kp2] manifest.onContextLauch fired', {
          title: object && object.title,
          movie_id: object && object.id
        });
        resetTemplates();
        Lampa.Component.add('online_kinopub2', component);
        Lampa.Activity.push({
          url: '', title: Lampa.Lang.translate('title_online'),
          component: 'online_kinopub2',
          search: object.title, search_one: object.title, search_two: object.original_title,
          movie: object, page: 1
        });
      }
    };
    Lampa.Manifest.plugins = manifest;

    Lampa.Lang.add({
      online_watch:  { ru: 'Смотреть онлайн', en: 'Watch online', uk: 'Дивитися онлайн' },
      online_video:  { ru: 'Видео', en: 'Video', uk: 'Відео' },
      online_nolink: { ru: 'Не удалось извлечь ссылку', en: 'Failed to fetch link', uk: 'Неможливо отримати посилання' },
      title_online:  { ru: 'Онлайн', en: 'Online', uk: 'Онлайн' },
      title_online_v2: { ru: 'Kinopub 2 (TV)', en: 'Kinopub 2 (TV)', uk: 'Kinopub 2 (TV)' },
      kp_modal_text: { ru: 'Введите код на https://kinopub.tv/device или вставьте имеющийся access-token', en: 'Enter code at https://kinopub.tv/device or paste an existing access-token', uk: 'Введіть код або вставте access-token' },
      kp_modal_wait: { ru: 'Ожидаем код', en: 'Waiting for the code', uk: 'Очікуємо код' },
      kp_oauth_failed: { ru: 'OAuth недоступен. Можно вставить токен с kino.pub/api.', en: 'OAuth unavailable. Paste a token from kino.pub/api.', uk: 'OAuth недоступний. Вставте токен з kino.pub/api.' },
      kp_paste_token:  { ru: 'Вставить токен', en: 'Paste token', uk: 'Вставити токен' },
      kp_token_empty:  { ru: 'Пустой токен', en: 'Empty token', uk: 'Порожній токен' },
      copy_secuses: { ru: 'Скопировано', en: 'Copied', uk: 'Скопійовано' },
      copy_fail:    { ru: 'Ошибка копирования', en: 'Copy error', uk: 'Помилка копіювання' },
      online_clear_all_marks:     { ru: 'Очистить все метки', en: 'Clear all marks', uk: 'Очистити мітки' },
      online_clear_all_timecodes: { ru: 'Очистить все тайм-коды', en: 'Clear all timecodes', uk: 'Очистити тайм-коди' },
      online_balanser_dont_work:  { ru: 'Поиск не дал результатов', en: 'No results', uk: 'Немає результатів' },
      online_specials: { ru: 'Спецвыпуски', en: 'Specials', uk: 'Спецвипуски' },
      helper_online_file: { ru: 'Удерживайте «ОК» для контекстного меню', en: 'Hold OK for context menu', uk: 'Утримуйте OK' },

      kp_modal_text: {
        ru: 'Откройте {url} и введите код. Окно закроется автоматически.',
        en: 'Open {url} and enter the code. This window will close automatically.',
        uk: 'Відкрийте {url} і введіть код. Вікно закриється автоматично.'
      },
      kp_modal_wait:    { ru: 'Получаем код',          en: 'Getting the code',     uk: 'Отримуємо код' },
      kp_auth_error:    { ru: 'Ошибка авторизации',     en: 'Authorization error',  uk: 'Помилка авторизації' },
      kp_logged_in:     { ru: 'Авторизован',            en: 'Signed in',            uk: 'Авторизовано' },
      kp_not_logged_in: { ru: 'Не авторизован',         en: 'Not signed in',        uk: 'Не авторизовано' },
      kp_logout:        { ru: 'Выйти',                  en: 'Sign out',             uk: 'Вийти' },
      kp_logout_desc:   { ru: 'Удалить токен и пройти авторизацию заново', en: 'Remove token and re-authorize', uk: 'Видалити токен та авторизуватися заново' },
      kp_logged_out:    { ru: 'Вы вышли',               en: 'Signed out',           uk: 'Вихід виконано' },
      copy_secuses:     { ru: 'Код скопирован',         en: 'Code copied',          uk: 'Код скопійовано' },
      copy_fail:        { ru: 'Ошибка копирования',     en: 'Copy error',           uk: 'Помилка копіювання' }
    });

    Lampa.Template.add('online_prestige_css', "<style>.online-prestige{position:relative;border-radius:.3em;background-color:rgba(0,0,0,0.3);display:flex}.online-prestige__body{padding:1.2em;line-height:1.3;flex-grow:1;position:relative}.online-prestige__img{position:relative;width:13em;flex-shrink:0;min-height:8.2em}.online-prestige__img>img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;border-radius:.3em;opacity:0;transition:opacity .3s}.online-prestige__img--loaded>img{opacity:1}@media screen and (max-width:480px){.online-prestige__img{width:7em;min-height:6em}}.online-prestige__folder{padding:1em;flex-shrink:0}.online-prestige__folder>svg{width:4.4em !important;height:4.4em !important}.online-prestige__viewed{position:absolute;top:1em;left:1em;background:rgba(0,0,0,0.45);border-radius:100%;padding:.25em}.online-prestige__viewed>svg{width:1.5em !important;height:1.5em !important}.online-prestige__episode-number{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:2em}.online-prestige__loader{position:absolute;top:50%;left:50%;width:2em;height:2em;margin:-1em 0 0 -1em;background:url(./img/loader.svg) no-repeat center center;background-size:contain}.online-prestige__head,.online-prestige__footer{display:flex;justify-content:space-between;align-items:center}.online-prestige__timeline{margin:.8em 0}.online-prestige__title{font-size:1.7em;overflow:hidden;text-overflow:ellipsis}.online-prestige__time{padding-left:2em}.online-prestige__info{display:flex;align-items:center}.online-prestige__quality{padding-left:1em;white-space:nowrap}.online-prestige .online-prestige-split{font-size:.8em;margin:0 1em;flex-shrink:0}.online-prestige.focus::after{content:'';position:absolute;top:-.6em;left:-.6em;right:-.6em;bottom:-.6em;border-radius:.7em;border:solid .3em #fff;z-index:-1;pointer-events:none}.online-prestige+.online-prestige{margin-top:1.5em}.online-prestige-rate{display:inline-flex;align-items:center}.online-prestige-rate>svg{width:1.3em !important;height:1.3em !important}.online-prestige-rate>span{font-weight:600;font-size:1.1em;padding-left:.7em}.online-empty__title{font-size:2em;margin-bottom:.9em}.online-empty-template{background-color:rgba(255,255,255,0.3);padding:1em;display:flex;align-items:center;border-radius:.3em}.online-empty-template>*{background:rgba(0,0,0,0.3);border-radius:.3em}.online-empty-template__ico{width:4em;height:4em;margin-right:2.4em}.online-empty-template__body{height:1.7em;width:70%}.online-empty-template+.online-empty-template{margin-top:1em}</style>");
    $('body').append(Lampa.Template.get('online_prestige_css', {}, true));

    function resetTemplates() {
      Lampa.Template.add('online_prestige_full',
        '<div class="online-prestige online-prestige--full selector">' +
          '<div class="online-prestige__img"><img alt=""><div class="online-prestige__loader"></div></div>' +
          '<div class="online-prestige__body">' +
            '<div class="online-prestige__head"><div class="online-prestige__title">{title}</div><div class="online-prestige__time">{time}</div></div>' +
            '<div class="online-prestige__timeline"></div>' +
            '<div class="online-prestige__footer"><div class="online-prestige__info">{info}</div><div class="online-prestige__quality">{quality}</div></div>' +
          '</div>' +
        '</div>');
      Lampa.Template.add('online_does_not_answer',
        '<div class="online-empty">' +
          '<div class="online-empty__title" style="font-size:2em;margin-bottom:.9em;">#{online_balanser_dont_work}</div>' +
          '<div class="online-empty__templates">' +
            '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
            '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
            '<div class="online-empty-template"><div class="online-empty-template__ico"></div><div class="online-empty-template__body"></div></div>' +
          '</div>' +
        '</div>');
      Lampa.Template.add('online_prestige_rate',
        '<div class="online-prestige-rate">' +
          '<svg width="17" height="16" viewBox="0 0 17 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.39409 0.192L10.99 5.31L16.79 6.20L12.55 10.43L13.58 15.93L8.39 13.24L3.21 15.93L4.24 10.43L0 6.20L5.80 5.31L8.39 0.19Z" fill="#fff"/></svg>' +
          '<span>{rate}</span>' +
        '</div>');
      Lampa.Template.add('online_prestige_folder',
        '<div class="online-prestige online-prestige--folder selector">' +
          '<div class="online-prestige__folder">' +
            '<svg viewBox="0 0 128 112" fill="none" xmlns="http://www.w3.org/2000/svg"><rect y="20" width="128" height="92" rx="13" fill="white"/><rect x="11" y="8" width="106" height="76" rx="13" fill="white" fill-opacity="0.51"/></svg>' +
          '</div>' +
          '<div class="online-prestige__body">' +
            '<div class="online-prestige__head"><div class="online-prestige__title">{title}</div><div class="online-prestige__time">{time}</div></div>' +
            '<div class="online-prestige__footer"><div class="online-prestige__info">{info}</div></div>' +
          '</div>' +
        '</div>');
    }

    var button = '<div class="full-start__button selector view--online" data-subtitle="Kinopub v' + PLUGIN_VERSION + '">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' +
      '<span>#{title_online_v2}</span>' +
    '</div>';

    Lampa.Component.add('online_kinopub2', component);
    resetTemplates();

    Lampa.Listener.follow('full', function(e) {
      console.log('[kp2] full listener fired', { type: e && e.type });
      if (e.type == 'complite') {
        var btn = $(Lampa.Lang.translate(button));
        btn.on('hover:enter', function() {
          console.log('[kp2] button hover:enter clicked');
          resetTemplates();
          Lampa.Component.add('online_kinopub2', component);
          Lampa.Activity.push({
            url: '', title: Lampa.Lang.translate('title_online'),
            component: 'online_kinopub2',
            search: e.data.movie.title, search_one: e.data.movie.title, search_two: e.data.movie.original_title,
            movie: e.data.movie, page: 1
          });
        });
        var $render = e.object && e.object.activity && e.object.activity.render && e.object.activity.render();
        var $torrent = $render && $render.find('.view--torrent');
        console.log('[kp2] inserting button', {
          render_found: !!$render,
          render_size: $render && $render.length,
          torrent_found: $torrent && $torrent.length,
          movie_id: e && e.data && e.data.movie && e.data.movie.id
        });
        if ($torrent && $torrent.length) $torrent.after(btn);
        else if ($render && $render.length) $render.find('.full-start__buttons').append(btn);
      }
    });

    Lampa.SettingsApi.addComponent({
      component: 'kinopub2', name: 'Kinopub',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    });
    Lampa.SettingsApi.addParam({
      component: 'kinopub2',
      param: { name: 'kp_version_info', type: 'static' },
      field: { name: 'Kinopub v' + PLUGIN_VERSION, description: '' },
      onRender: function(el) {
        try {
          el.find('.settings-param__value').text(kp_token
            ? Lampa.Lang.translate('kp_logged_in')
            : Lampa.Lang.translate('kp_not_logged_in'));
        } catch (e) {}
      }
    });
    Lampa.SettingsApi.addParam({
      component: 'kinopub2',
      param: { name: 'kp_logout_btn', type: 'button' },
      field: {
        name:        Lampa.Lang.translate('kp_logout'),
        description: Lampa.Lang.translate('kp_logout_desc')
      },
      onChange: function() {
        Lampa.Storage.set('kp_token', '');
        Lampa.Storage.set('kp_refresh_token', '');
        Lampa.Storage.set('kp_token_expires', 0);
        kp_token = ''; kp_refresh_token = '';
        Lampa.Noty.show(Lampa.Lang.translate('kp_logged_out'));
        setTimeout(function() { window.location.reload(); }, 600);
      }
    });

    if (Lampa.Manifest.app_digital >= 177) {
      Lampa.Storage.sync('online_choice_kp2',  'object_object');
      Lampa.Storage.sync('online_watched_last',  'object_object');
    }
  }

  try {
    console.log('[kp2 v' + PLUGIN_VERSION + '] gate', {
      already: !!window.online_kinopub2,
      app_digital: (Lampa.Manifest && Lampa.Manifest.app_digital),
      hls_present: !!window.Hls,
      hls_version: (window.Hls && window.Hls.version),
      kp_token_len: (kp_token || '').length
    });
  } catch (e) {}
  if (!window.online_kinopub2 && Lampa.Manifest.app_digital >= 155) startPlugin();
  else console.log('[kp2] startPlugin SKIPPED');

})();
