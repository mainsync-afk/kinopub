/*!
 * Kinopub plugin for Lampa  v1.4.8
 * https://github.com/mainsync-afk/kinopub
 *
 * Источник kino.pub в карточке Lampa. Структура — копия filmix.js,
 * заменён только источник (kpapi). Авторизация временно отключена:
 * токен хардкодится; OAuth/паста-форма будут добавлены позже.
 */
(function() {
  'use strict';

  var PLUGIN_VERSION = '1.4.8';

  // TEMP: токен хардкодится в коде. Полноценная авторизация — следующим этапом.
  // Время жизни ~24ч, обновлять отсюда https://kino.pub/api → console snippet.
  var kp_token = 'y5yewmq01148rdz8n173sc48o7q2i4os';

  var api_url  = 'https://api.service-kp.com/v1/';

  /* ---------- helpers ---------- */

  function bearerHeaders() {
    return { Authorization: 'Bearer ' + kp_token };
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
      network.silent(url, function(json) {
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
        if (c == 401) {
          // токен умер — стираем и просим войти заново
          kp_token = '';
          Lampa.Storage.set('kp_token', '');
        }
        component.doesNotAnswer();
      }, false, { headers: bearerHeaders() });
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
      network.silent(url, function(found) {
        if (found && found.item) {
          success(found.item);
          component.loading(false);
        } else component.doesNotAnswer();
      }, function(a, c) {
        if (c == 401) { kp_token = ''; Lampa.Storage.set('kp_token', ''); }
        component.doesNotAnswer();
      }, false, { headers: bearerHeaders() });
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
        translation:    transl_id
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

        // Озвучки. URL един для всех — фильтр меняет только метаданные,
        // которые потом плеер использует через hls.audioTrack.
        if (results.__voices && results.__voices.length) {
          results.__voices.forEach(function(v, idx) {
            var label = v.name || ('Audio ' + (idx + 1));
            if (filter_items.voice.indexOf(label) === -1) {
              filter_items.voice.push(label);
              filter_items.voice_info.push({ id: 1, voice: v });
            }
          });
        }
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
        var voiceMeta = (filter_items.voice_info[choice.voice] && filter_items.voice_info[choice.voice].voice) || null;
        var voiceLabel = filter_items.voice[choice.voice] || (voiceMeta && voiceMeta.name) || '';
        var element = extract[1];
        if (element && element.json) {
          for (var si in element.json) {
            var ep = element.json[si];
            if (ep.id == choice.season + 1) {
              ep.folder.forEach(function(media) {
                out.push({
                  episode:      parseInt(media.episode),
                  season:       media.season,
                  title:        Lampa.Lang.translate('torrent_serial_episode') + ' ' + media.episode + (media.title ? ' — ' + media.title : ''),
                  quality:      media.quality + 'p ',
                  qualitys:     media.qualities_map,
                  translation:  media.translation,
                  voice_name:   voiceLabel,
                  voice_lang:   voiceMeta ? voiceMeta.lang   : '',
                  voice_author: voiceMeta ? voiceMeta.author : '',
                  voice_index:  voiceMeta ? voiceMeta.index  : 0,
                  info:         voiceLabel
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
    var network = new Lampa.Reguest();
    var scroll  = new Lampa.Scroll({ mask: true, over: true });
    var files   = new Lampa.Explorer(object);
    var filter  = new Lampa.Filter(object);
    var sources = { kpapi: kpapi };
    var last;
    var extended;
    var selected_id;
    var source;
    var balanser = 'kpapi';
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
    };
  }

  /* ==========================================================
   *                       startPlugin
   * ========================================================== */

  /* ==========================================================
   *      AUDIO TRACK SWITCH (через hls.js / video.audioTracks)
   * ========================================================== */

  // Подбираем индекс аудио-трека под сохранённую озвучку.
  // Сначала смотрим точное соответствие по lang+author, потом по lang,
  // потом по голому индексу (как фоллбэк).
  function findAudioTrackIdx(tracks, voice) {
    if (!tracks || !tracks.length || !voice) return -1;
    var lang = (voice.lang || '').toLowerCase();
    var author = (voice.author || '').toLowerCase();

    function trackLabel(t) {
      // hls.js: {lang, name, ...}; native: {language, label, kind}
      return ((t.name || t.label || '') + '').toLowerCase();
    }
    function trackLang(t) {
      return ((t.lang || t.language || '') + '').toLowerCase();
    }

    if (lang && author) {
      for (var i = 0; i < tracks.length; i++) {
        if (trackLang(tracks[i]) === lang && trackLabel(tracks[i]).indexOf(author) >= 0) return i;
      }
    }
    if (lang) {
      for (var j = 0; j < tracks.length; j++) {
        if (trackLang(tracks[j]) === lang) return j;
      }
    }
    if (typeof voice.index === 'number' && voice.index >= 0 && voice.index < tracks.length) {
      return voice.index;
    }
    return -1;
  }

  function applyKinopubVoice() {
    var voice = window.__kp_pending_voice;
    if (!voice || (!voice.lang && !voice.author && voice.index == null)) return;

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
    if (window.Hls && window.Hls.__kp_patched) return;
    if (window.Hls) { patchHls(); return; }
    var tries = 0;
    var iv = setInterval(function() {
      if (window.Hls && !window.Hls.__kp_patched) {
        clearInterval(iv);
        patchHls();
      } else if (++tries > 120) { // 60 секунд — c запасом
        clearInterval(iv);
      }
    }, 500);
  }

  function patchHls() {
    if (!window.Hls || window.Hls.__kp_patched) return;
    var Original = window.Hls;

    function Patched(config) {
      var inst = new Original(config);
      window.__kp_hls = inst;
      try {
        var EV = (Original.Events) || (Patched.Events);
        if (EV && EV.AUDIO_TRACKS_UPDATED) {
          inst.on(EV.AUDIO_TRACKS_UPDATED, function() { applyKinopubVoice(); });
        }
        if (EV && EV.MANIFEST_PARSED) {
          inst.on(EV.MANIFEST_PARSED, function() { setTimeout(applyKinopubVoice, 200); });
        }
      } catch (e) {}
      return inst;
    }
    // Копируем статику (Events, ErrorTypes, isSupported, ...)
    for (var k in Original) {
      if (Object.prototype.hasOwnProperty.call(Original, k)) {
        try { Patched[k] = Original[k]; } catch (e) {}
      }
    }
    Patched.prototype = Original.prototype;
    Patched.__kp_patched = true;
    Patched.__original = Original;
    window.Hls = Patched;
  }

  // Слушаем события плеера: на старт каждого нового стрима (новая серия,
  // переоткрытие, и т.п.) повторно применяем озвучку. Это страховка на случай
  // если monkey-patch был установлен ПОСЛЕ создания Hls-инстанса.
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
        if (e && (e.type === 'start' || e.type === 'video' || e.type === 'change' || e.type === 'inited')) apply();
      });
    } catch (e) {}

    // Канал 2: Lampa.Player.listener (отдельный Listener плеера)
    try {
      if (Lampa.Player && Lampa.Player.listener && Lampa.Player.listener.follow) {
        Lampa.Player.listener.follow('start', apply);
        Lampa.Player.listener.follow('video', apply);
      }
    } catch (e) {}
  }

  function startPlugin() {
    window.online_kinopub = true;
    ensurePatchHls();     // дождаться window.Hls и подменить конструктор
    bindPlayerListener(); // страховка на повторное применение озвучки

    var manifest = {
      type:        'video',
      version:     PLUGIN_VERSION,
      name:        'Онлайн - Kinopub',
      description: 'Плагин для просмотра онлайн kino.pub',
      component:   'online_kinopub',
      onContextMenu: function() {
        return { name: Lampa.Lang.translate('online_watch'), description: '' };
      },
      onContextLauch: function(object) {
        resetTemplates();
        Lampa.Component.add('online_kinopub', component);
        Lampa.Activity.push({
          url: '', title: Lampa.Lang.translate('title_online'),
          component: 'online_kinopub',
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
      helper_online_file: { ru: 'Удерживайте «ОК» для контекстного меню', en: 'Hold OK for context menu', uk: 'Утримуйте OK' }
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
      '<span>#{title_online}</span>' +
    '</div>';

    Lampa.Component.add('online_kinopub', component);
    resetTemplates();

    Lampa.Listener.follow('full', function(e) {
      if (e.type == 'complite') {
        var btn = $(Lampa.Lang.translate(button));
        btn.on('hover:enter', function() {
          resetTemplates();
          Lampa.Component.add('online_kinopub', component);
          Lampa.Activity.push({
            url: '', title: Lampa.Lang.translate('title_online'),
            component: 'online_kinopub',
            search: e.data.movie.title, search_one: e.data.movie.title, search_two: e.data.movie.original_title,
            movie: e.data.movie, page: 1
          });
        });
        e.object.activity.render().find('.view--torrent').after(btn);
      }
    });

    Lampa.SettingsApi.addComponent({
      component: 'kinopub', name: 'Kinopub',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
    });
    Lampa.SettingsApi.addParam({
      component: 'kinopub',
      param: { name: 'kp_version_info', type: 'static' },
      field: { name: 'Kinopub v' + PLUGIN_VERSION, description: 'Авторизация: токен задан в коде' }
    });

    if (Lampa.Manifest.app_digital >= 177) {
      Lampa.Storage.sync('online_choice_kpapi',  'object_object');
      Lampa.Storage.sync('online_watched_last',  'object_object');
    }
  }

  if (!window.online_kinopub && Lampa.Manifest.app_digital >= 155) startPlugin();

})();
