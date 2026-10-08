// Public diary viewer: shows the entries the owner chose to publish, updated live.
// Private entries and their photos are never readable here (enforced by the database).
(function () {
  "use strict";
  var config = window.DIARY_CONFIG;
  var timeZone = config.timeZone || "Asia/Tokyo";
  var client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  var entries = new Map();
  // Entry id -> ids of the public entries it is linked to (links to private entries are not readable).
  var related = new Map();
  var fresh = new Set();
  var main = document.getElementById("entries");
  var status = document.getElementById("status");

  var dateFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: timeZone, month: "numeric", day: "numeric", weekday: "short" });
  var keyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  // Photo paths -> signed URLs (the photo bucket is private; public entries' photos may be signed).
  var photoUrls = new Map();

  var timeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  function snippet(entry) {
    var text = (entry.body || "").replace(/\s+/g, " ").trim();
    if (!text) return "写真";
    return text.length > 24 ? text.slice(0, 24) + "…" : text;
  }

  function render() {
    var sorted = Array.from(entries.values()).sort(function (a, b) {
      return a.written_at < b.written_at ? 1 : -1;
    });
    main.replaceChildren();
    if (sorted.length === 0) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "まだ日記はありません。";
      main.append(empty);
      return;
    }
    var currentKey = null;
    var list = null;
    sorted.forEach(function (entry) {
      var instant = new Date(entry.written_at);
      var key = keyFormat.format(instant);
      if (key !== currentKey) {
        currentKey = key;
        var section = document.createElement("section");
        var heading = document.createElement("h2");
        heading.textContent = dateFormat.format(instant);
        list = document.createElement("ol");
        section.append(heading, list);
        main.append(section);
      }
      var item = document.createElement("li");
      item.dataset.id = entry.id;
      item.id = "e-" + entry.id;
      if (fresh.has(entry.id)) item.className = "new";
      var time = document.createElement("time");
      time.dateTime = entry.written_at;
      time.textContent = timeFormat.format(instant);
      var content = document.createElement("div");
      content.className = "content";
      if (entry.body) {
        var body = document.createElement("div");
        body.className = "body";
        body.textContent = entry.body; // never innerHTML: entries are plain text
        content.append(body);
      }
      var paths = entry.photo_paths || [];
      if (paths.length > 0) {
        var gallery = document.createElement("div");
        gallery.className = "photos";
        paths.forEach(function (path, index) {
          var url = photoUrls.get(path);
          if (!url) return;
          var link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          var image = document.createElement("img");
          image.src = link.href;
          image.alt = "写真 " + (index + 1);
          image.loading = "lazy";
          image.decoding = "async";
          link.append(image);
          gallery.append(link);
        });
        content.append(gallery);
      }
      var others = (related.get(entry.id) || [])
        .map(function (id) { return entries.get(id); })
        .filter(Boolean)
        .sort(function (a, b) { return a.written_at < b.written_at ? -1 : 1; });
      if (others.length > 0) {
        var links = document.createElement("ul");
        links.className = "related";
        links.setAttribute("aria-label", "つながった日記");
        others.forEach(function (other) {
          var li = document.createElement("li");
          var anchor = document.createElement("a");
          anchor.href = "#e-" + other.id;
          anchor.textContent = "🔗 " + dateFormat.format(new Date(other.written_at)) + " " + snippet(other);
          li.append(anchor);
          links.append(li);
        });
        content.append(links);
      }
      item.append(time, content);
      list.append(item);
    });
  }

  function loadLinks() {
    return client
      .from("diary_links")
      .select("entry_id, linked_id")
      .then(function (result) {
        if (result.error) throw result.error;
        related.clear();
        result.data.forEach(function (link) {
          [[link.entry_id, link.linked_id], [link.linked_id, link.entry_id]].forEach(function (pair) {
            related.set(pair[0], (related.get(pair[0]) || []).concat(pair[1]));
          });
        });
      });
  }

  function load() {
    return Promise.all([loadLinks(), loadEntries()]).then(function (results) {
      render();
      return results;
    });
  }

  function loadEntries() {
    return client
      .from("diary_entries")
      .select("id, body, written_at, photo_paths")
      .eq("is_public", true)
      .order("written_at", { ascending: false })
      .limit(500)
      .then(function (result) {
        if (result.error) throw result.error;
        var rows = result.data;
        var paths = [];
        rows.forEach(function (entry) {
          (entry.photo_paths || []).forEach(function (path) { paths.push(path); });
        });
        var signing = paths.length === 0
          ? Promise.resolve({ data: [] })
          : client.storage.from("diary-photos").createSignedUrls(paths, 3600);
        return signing.then(function (signed) {
          photoUrls.clear();
          (signed.data || []).forEach(function (item) {
            if (item.signedUrl) photoUrls.set(item.path, item.signedUrl);
          });
          var known = new Set(entries.keys());
          entries.clear();
          rows.forEach(function (entry) {
            entries.set(entry.id, entry);
            if (known.size > 0 && !known.has(entry.id)) fresh.add(entry.id);
          });
        });
      });
  }

  var timer = null;
  function reloadSoon() {
    clearTimeout(timer);
    timer = setTimeout(function () { load().catch(showError); }, 200);
  }

  // The app announces publishing, unpublishing and deleting on this topic (no content is sent);
  // a row that becomes private is not delivered as a database change, so this is what removes it.
  client
    .channel("diary-public")
    .on("broadcast", { event: "changed" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "diary_entries" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "diary_links" }, reloadSoon)
    .subscribe(function (state) {
      if (state === "SUBSCRIBED") {
        status.textContent = "● リアルタイム更新中";
        // Catch anything written while connecting.
        reloadSoon();
      } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
        status.textContent = "更新が止まっています。再読み込みしてください。";
      }
    });

  function showError() {
    status.textContent = "日記を読み込めませんでした。時間をおいて再読み込みしてください。";
  }

  load().catch(showError);
  // Signed photo URLs last an hour; refresh well before, and whenever the tab comes back.
  setInterval(reloadSoon, 20 * 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") reloadSoon();
  });
})();
