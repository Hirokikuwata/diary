// Public diary viewer: loads entries from Supabase and shows new ones live (Supabase Realtime).
(function () {
  "use strict";
  var config = window.DIARY_CONFIG;
  var timeZone = config.timeZone || "Asia/Tokyo";
  var client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  var entries = new Map();
  var fresh = new Set();
  var main = document.getElementById("entries");
  var status = document.getElementById("status");

  var dateFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: timeZone, month: "numeric", day: "numeric", weekday: "short" });
  var keyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  var photoBase = config.supabaseUrl.replace(/\/$/, "") + "/storage/v1/object/public/diary-photos/";

  function photoUrl(path) {
    return photoBase + path.split("/").map(encodeURIComponent).join("/");
  }

  var timeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

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
          var link = document.createElement("a");
          link.href = photoUrl(path);
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
      item.append(time, content);
      list.append(item);
    });
  }

  function load() {
    return client
      .from("diary_entries")
      .select("id, body, written_at, photo_paths")
      .order("written_at", { ascending: false })
      .limit(500)
      .then(function (result) {
        if (result.error) throw result.error;
        entries.clear();
        result.data.forEach(function (entry) {
          entries.set(entry.id, entry);
        });
        render();
      });
  }

  client
    .channel("diary")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "diary_entries" }, function (payload) {
      var row = payload.new;
      entries.set(row.id, { id: row.id, body: row.body, written_at: row.written_at, photo_paths: row.photo_paths || [] });
      fresh.add(row.id);
      render();
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "diary_entries" }, function (payload) {
      entries.delete(payload.old.id);
      render();
    })
    .subscribe(function (state) {
      if (state === "SUBSCRIBED") {
        status.textContent = "● リアルタイム更新中";
        // Catch anything written while connecting.
        load().catch(showError);
      } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
        status.textContent = "更新が止まっています。再読み込みしてください。";
      }
    });

  function showError() {
    status.textContent = "日記を読み込めませんでした。時間をおいて再読み込みしてください。";
  }

  load().catch(showError);
})();
