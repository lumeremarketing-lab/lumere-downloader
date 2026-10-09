// =============================================================
//  Lumere Downloader - Ajudante (host de "native messaging")
//  A extensão conversa com este programa, que usa o yt-dlp para
//  baixar vídeos do YouTube e de outros sites.
//  Compilado automaticamente pelo instalar.ps1 (não precisa de Visual Studio).
// =============================================================
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class MvdHost
{
    const string VERSION = "2.2.0";
    static Stream stdout;
    static readonly object writeLock = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static string baseDir, binDir, ytdlpPath, galleryPath, ffmpegPath, ffprobePath, uploadDir;
    static readonly Dictionary<string, string> uploads = new Dictionary<string, string>();
    static readonly Dictionary<string, Process> jobs = new Dictionary<string, Process>();
    static readonly HashSet<string> cancelled = new HashSet<string>();
    static readonly HashSet<string> reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    static bool IsWindows { get { return Path.DirectorySeparatorChar == '\\'; } }

    public static int Main(string[] args)
    {
        json.MaxJsonLength = int.MaxValue;
        baseDir = AppDomain.CurrentDomain.BaseDirectory;
        binDir = Path.Combine(baseDir, "bin");
        ytdlpPath = Environment.GetEnvironmentVariable("MVD_YTDLP");
        if (string.IsNullOrEmpty(ytdlpPath)) ytdlpPath = Path.Combine(binDir, IsWindows ? "yt-dlp.exe" : "yt-dlp");
        galleryPath = Tool("MVD_GALLERYDL", "gallery-dl");
        ffmpegPath = Tool("MVD_FFMPEG", "ffmpeg");
        ffprobePath = Tool("MVD_FFPROBE", "ffprobe");
        uploadDir = Path.Combine(Path.GetTempPath(), "mvd-uploads");

        Stream stdin = Console.OpenStandardInput();
        stdout = Console.OpenStandardOutput();

        while (true)
        {
            byte[] lenBuf = ReadExact(stdin, 4);
            if (lenBuf == null) break;
            int len = BitConverter.ToInt32(lenBuf, 0);
            if (len <= 0 || len > 64 * 1024 * 1024) break;
            byte[] body = ReadExact(stdin, len);
            if (body == null) break;
            Dictionary<string, object> msg;
            try { msg = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body)); }
            catch { continue; }
            try { Handle(msg); }
            catch (Exception e) { Reply(Str(msg, "rid"), false, e.Message, null); }
        }

        // O Chrome fechou a conexão: encerra downloads em andamento e limpa temporários
        lock (jobs) { foreach (Process p in jobs.Values) KillTree(p); }
        lock (uploads) { foreach (string f in uploads.Values) TryDelete(f); }
        return 0;
    }

    static string Tool(string envVar, string name)
    {
        string v = Environment.GetEnvironmentVariable(envVar);
        if (!string.IsNullOrEmpty(v)) return v;
        return Path.Combine(binDir, IsWindows ? name + ".exe" : name);
    }

    static void TryDelete(string path)
    {
        try { if (path != null && File.Exists(path)) File.Delete(path); } catch { }
    }

    // ---------------- protocolo ----------------
    static byte[] ReadExact(Stream s, int n)
    {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n)
        {
            int r = s.Read(buf, off, n - off);
            if (r <= 0) return null;
            off += r;
        }
        return buf;
    }

    static void Send(Dictionary<string, object> obj)
    {
        byte[] data = Encoding.UTF8.GetBytes(json.Serialize(obj));
        lock (writeLock)
        {
            stdout.Write(BitConverter.GetBytes(data.Length), 0, 4);
            stdout.Write(data, 0, data.Length);
            stdout.Flush();
        }
    }

    static void Reply(string rid, bool ok, string error, Dictionary<string, object> extra)
    {
        Dictionary<string, object> m = extra ?? new Dictionary<string, object>();
        m["type"] = "reply";
        m["rid"] = rid;
        m["ok"] = ok;
        if (error != null) m["error"] = error;
        Send(m);
    }

    static void Event(string job, string type, Dictionary<string, object> extra)
    {
        Dictionary<string, object> m = extra ?? new Dictionary<string, object>();
        m["type"] = type;
        m["job"] = job;
        Send(m);
    }

    static string Str(Dictionary<string, object> m, string k)
    {
        object v;
        return m != null && m.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
    }

    // ---------------- comandos ----------------
    static void Handle(Dictionary<string, object> msg)
    {
        string cmd = Str(msg, "cmd");
        string rid = Str(msg, "rid");

        if (cmd == "ping")
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["version"] = VERSION;
            r["ytdlp"] = File.Exists(ytdlpPath) || !IsWindows ? RunQuick(new List<string> { "--version" }) : null;
            r["gallery"] = File.Exists(galleryPath) || Environment.GetEnvironmentVariable("MVD_GALLERYDL") != null;
            r["ffmpeg"] = File.Exists(ffmpegPath) || Environment.GetEnvironmentVariable("MVD_FFMPEG") != null;
            r["features"] = new List<string> { "info", "download", "gallery", "upload", "media" };
            Reply(rid, true, null, r);
        }
        else if (cmd == "info")
        {
            new Thread(delegate () { Info(rid, msg); }) { IsBackground = true }.Start();
        }
        else if (cmd == "download")
        {
            new Thread(delegate () { Download(rid, msg); }) { IsBackground = true }.Start();
        }
        else if (cmd == "cancel")
        {
            string job = Str(msg, "job");
            lock (jobs)
            {
                Process p;
                if (job != null && jobs.TryGetValue(job, out p)) { cancelled.Add(job); KillTree(p); }
            }
            Reply(rid, true, null, null);
        }
        else if (cmd == "show")
        {
            string path = Str(msg, "path");
            if (IsWindows && path != null)
                Process.Start("explorer.exe", "/select,\"" + path + "\"");
            Reply(rid, true, null, null);
        }
        else if (cmd == "update")
        {
            new Thread(delegate () {
                string outp = RunQuick(new List<string> { "-U" });
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["output"] = outp;
                Reply(rid, true, null, r);
            }) { IsBackground = true }.Start();
        }
        else if (cmd == "gallery")
        {
            new Thread(delegate () { Gallery(rid, msg); }) { IsBackground = true }.Start();
        }
        else if (cmd == "upload-begin")
        {
            Directory.CreateDirectory(uploadDir);
            string name = SafeName(Str(msg, "name") ?? "arquivo");
            string token = Guid.NewGuid().ToString("N");
            string path = Path.Combine(uploadDir, token + "_" + name);
            File.WriteAllBytes(path, new byte[0]);
            lock (uploads) uploads[token] = path;
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["token"] = token;
            Reply(rid, true, null, r);
        }
        else if (cmd == "upload-chunk")
        {
            string path;
            lock (uploads) uploads.TryGetValue(Str(msg, "token") ?? "", out path);
            if (path == null) { Reply(rid, false, "Envio desconhecido.", null); return; }
            byte[] data = Convert.FromBase64String(Str(msg, "data") ?? "");
            using (FileStream fs = new FileStream(path, FileMode.Append, FileAccess.Write)) fs.Write(data, 0, data.Length);
            Reply(rid, true, null, null);
        }
        else if (cmd == "upload-cancel")
        {
            string path = null;
            lock (uploads) { string t = Str(msg, "token") ?? ""; if (uploads.TryGetValue(t, out path)) uploads.Remove(t); }
            TryDelete(path);
            Reply(rid, true, null, null);
        }
        else if (cmd == "media")
        {
            new Thread(delegate () { Media(rid, msg); }) { IsBackground = true }.Start();
        }
        else
        {
            Reply(rid, false, "Comando desconhecido: " + cmd, null);
        }
    }

    static List<string> HeaderArgs(Dictionary<string, object> msg)
    {
        List<string> a = new List<string>();
        object h;
        if (msg.TryGetValue("headers", out h) && h is Dictionary<string, object>)
        {
            foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)h)
            {
                if (kv.Value == null) continue;
                a.Add("--add-header");
                a.Add(kv.Key + ":" + kv.Value);
            }
        }
        return a;
    }

    // Lê título, miniatura, duração e qualidades disponíveis
    static void Info(string rid, Dictionary<string, object> msg)
    {
        string url = Str(msg, "url");
        List<string> args = new List<string> { "-J", "--no-playlist", "--no-warnings", "--encoding", "utf-8" };
        args.AddRange(HeaderArgs(msg));
        args.Add("--");
        args.Add(url);

        StringBuilder err = new StringBuilder();
        string output;
        int code;
        try { output = Run(args, err, out code); }
        catch (Exception e) { Reply(rid, false, "Não consegui abrir o yt-dlp: " + e.Message, null); return; }

        if (code != 0 || string.IsNullOrEmpty(output))
        {
            Reply(rid, false, LastError(err.ToString()), null);
            return;
        }

        Dictionary<string, object> d = json.Deserialize<Dictionary<string, object>>(output);
        Dictionary<string, object> r = new Dictionary<string, object>();
        r["title"] = Str(d, "title");
        r["thumbnail"] = Str(d, "thumbnail");
        r["duration"] = d.ContainsKey("duration") ? d["duration"] : null;
        r["uploader"] = Str(d, "uploader");
        r["site"] = Str(d, "extractor_key");
        r["url"] = Str(d, "webpage_url") ?? url;
        r["isLive"] = d.ContainsKey("is_live") && d["is_live"] is bool && (bool)d["is_live"];

        SortedSet<int> heights = new SortedSet<int>();
        bool hasAudio = false;
        object fo;
        if (d.TryGetValue("formats", out fo) && fo is System.Collections.IEnumerable)
        {
            foreach (object f in (System.Collections.IEnumerable)fo)
            {
                Dictionary<string, object> fm = f as Dictionary<string, object>;
                if (fm == null) continue;
                string vcodec = Str(fm, "vcodec"), acodec = Str(fm, "acodec");
                if (acodec != null && acodec != "none") hasAudio = true;
                object hv;
                if (vcodec != "none" && fm.TryGetValue("height", out hv) && hv != null)
                {
                    int hh;
                    if (int.TryParse(Convert.ToString(hv), out hh) && hh > 0) heights.Add(hh);
                }
            }
        }
        List<int> hs = new List<int>(heights);
        hs.Reverse();
        r["heights"] = hs;
        r["hasAudio"] = hasAudio;
        Reply(rid, true, null, r);
    }

    // Baixa com o yt-dlp, mandando o progresso para a extensão
    static void Download(string rid, Dictionary<string, object> msg)
    {
        string job = Str(msg, "job") ?? Guid.NewGuid().ToString("N");
        string url = Str(msg, "url");
        string quality = Str(msg, "quality") ?? "best"; // "best", "1080", "720", "audio"
        string dir = Str(msg, "dir");
        if (string.IsNullOrEmpty(dir))
            dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        string name = Str(msg, "filename");
        if (!string.IsNullOrEmpty(name)) name = UniqueName(dir, name);
        string template = string.IsNullOrEmpty(name) ? "%(title).150B.%(ext)s" : name.Replace("%", "%%") + ".%(ext)s";

        List<string> args = new List<string> {
            "--no-playlist", "--newline", "--progress", "--encoding", "utf-8", "--no-mtime",
            "-P", dir, "-o", template,
            "--progress-template", "download:MVD|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
            "--print", "after_move:MVDFILE|%(filepath)s",
        };
        if (Directory.Exists(binDir)) { args.Add("--ffmpeg-location"); args.Add(binDir); }

        if (quality == "audio")
        {
            args.AddRange(new[] { "-f", "ba/b", "-x", "--audio-format", "mp3" });
        }
        else
        {
            args.AddRange(new[] { "-f", "bv*+ba/b", "--merge-output-format", "mp4" });
            int h;
            args.Add("-S");
            args.Add(int.TryParse(quality, out h) ? "res:" + h + ",ext:mp4:m4a" : "res,ext:mp4:m4a");
        }
        args.AddRange(HeaderArgs(msg));
        args.Add("--");
        args.Add(url);

        Process p;
        try { p = Start(args); }
        catch (Exception e) { Reply(rid, false, "Não consegui abrir o yt-dlp: " + e.Message, null); return; }

        lock (jobs) { jobs[job] = p; }
        Dictionary<string, object> started = new Dictionary<string, object>();
        started["job"] = job;
        Reply(rid, true, null, started);

        string file = null;
        StringBuilder errors = new StringBuilder();
        int part = 1;
        double lastPct = 0;

        DataReceivedEventHandler onLine = delegate (object s, DataReceivedEventArgs e)
        {
            string line = e.Data;
            if (line == null) return;
            line = line.Trim();
            if (line.StartsWith("MVD|"))
            {
                string[] parts = line.Split('|');
                double pct;
                double.TryParse(parts[1].Replace("%", "").Trim(), System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out pct);
                if (pct + 30 < lastPct) part++;  // começou a baixar a próxima parte (ex.: áudio)
                lastPct = pct;
                Dictionary<string, object> ev = new Dictionary<string, object>();
                ev["percent"] = pct;
                ev["speed"] = parts.Length > 2 ? parts[2].Trim() : "";
                ev["eta"] = parts.Length > 3 ? parts[3].Trim() : "";
                ev["part"] = part;
                Event(job, "progress", ev);
            }
            else if (line.StartsWith("MVDFILE|"))
            {
                file = line.Substring(8);
            }
            else if (line.StartsWith("[Merger]") || line.StartsWith("[ExtractAudio]") || line.StartsWith("[VideoConvertor]"))
            {
                Dictionary<string, object> ev = new Dictionary<string, object>();
                ev["text"] = line.StartsWith("[ExtractAudio]") ? "Convertendo para MP3…" : "Juntando áudio e vídeo…";
                Event(job, "status", ev);
            }
            else if (line.StartsWith("ERROR:"))
            {
                lock (errors) errors.AppendLine(line);
            }
        };
        p.OutputDataReceived += onLine;
        p.ErrorDataReceived += onLine;
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        p.WaitForExit();
        p.WaitForExit(); // garante que as últimas linhas foram lidas

        bool wasCancelled;
        lock (jobs) { jobs.Remove(job); wasCancelled = cancelled.Remove(job); }

        Dictionary<string, object> end = new Dictionary<string, object>();
        if (wasCancelled) { Event(job, "cancelled", end); return; }
        if (p.ExitCode == 0)
        {
            end["file"] = file;
            Event(job, "done", end);
        }
        else
        {
            end["error"] = LastError(errors.ToString());
            Event(job, "error", end);
        }
    }

    // "Aula.mp4" já existe? usa "Aula (2)", "Aula (3)"...
    static string UniqueName(string dir, string name) { return UniqueName(dir, name, new[] { ".mp4", ".mkv", ".webm", ".mp3", ".m4a" }); }

    static string UniqueName(string dir, string name, string[] exts)
    {
        string candidate = name;
        lock (reserved)
        {
            for (int i = 2; i < 1000; i++)
            {
                bool exists = reserved.Contains(Path.Combine(dir, candidate));
                foreach (string e in exts) if (File.Exists(Path.Combine(dir, candidate + e))) { exists = true; break; }
                if (!exists) break;
                candidate = name + " (" + i + ")";
            }
            reserved.Add(Path.Combine(dir, candidate));
        }
        return candidate;
    }


    // =============================================================
    //  Instagram e outras galerias (gallery-dl): lista as fotos/vídeos
    // =============================================================
    static void Gallery(string rid, Dictionary<string, object> msg)
    {
        string url = Str(msg, "url");
        string cookies = Str(msg, "cookies");
        string cookieFile = null;
        try
        {
            List<string> args = new List<string> { "-j" };
            if (!string.IsNullOrEmpty(cookies))
            {
                cookieFile = Path.Combine(Path.GetTempPath(), "mvd-cookies-" + Guid.NewGuid().ToString("N") + ".txt");
                File.WriteAllText(cookieFile, cookies, new UTF8Encoding(false));
                args.Add("--cookies");
                args.Add(cookieFile);
            }
            args.Add("--");
            args.Add(url);

            StringBuilder err = new StringBuilder();
            int code;
            string output;
            try { output = Run(galleryPath, args, err, out code); }
            catch (Exception e) { Reply(rid, false, "Não consegui abrir o gallery-dl (reinstale o ajudante): " + e.Message, null); return; }

            List<object> items = new List<object>();
            string username = null, description = null, shortcode = null;
            object parsed = null;
            try { parsed = json.DeserializeObject(output); } catch { }
            System.Collections.IEnumerable arr = parsed as System.Collections.IEnumerable;
            if (arr != null && !(parsed is string))
            {
                foreach (object entry in arr)
                {
                    object[] e = entry as object[];
                    if (e == null || e.Length < 3) continue;
                    if (Convert.ToString(e[0]) != "3") continue; // 3 = arquivo
                    string fileUrl = Convert.ToString(e[1]);
                    Dictionary<string, object> meta = e[2] as Dictionary<string, object> ?? new Dictionary<string, object>();
                    if (fileUrl.StartsWith("ytdl:")) fileUrl = fileUrl.Substring(5);
                    string ext = (Str(meta, "extension") ?? "jpg").ToLowerInvariant();
                    Dictionary<string, object> it = new Dictionary<string, object>();
                    it["url"] = fileUrl;
                    it["ext"] = ext;
                    it["isVideo"] = ext == "mp4" || ext == "webm" || ext == "mov";
                    it["thumb"] = Str(meta, "display_url") ?? (ext == "mp4" ? null : fileUrl);
                    it["width"] = meta.ContainsKey("width") ? meta["width"] : null;
                    it["height"] = meta.ContainsKey("height") ? meta["height"] : null;
                    it["num"] = meta.ContainsKey("num") ? meta["num"] : items.Count + 1;
                    items.Add(it);
                    if (username == null) username = Str(meta, "username") ?? Str(meta, "owner") ?? Str(meta, "category");
                    if (shortcode == null) shortcode = Str(meta, "post_shortcode") ?? Str(meta, "shortcode") ?? Str(meta, "post_id") ?? Str(meta, "id");
                    if (description == null) description = Str(meta, "description") ?? Str(meta, "title");
                    if (items.Count >= 100) break;
                }
            }
            if (items.Count == 0)
            {
                string er = LastError(err.ToString() + "\n" + (output.Length < 2000 ? output : ""));
                if (er.IndexOf("login", StringComparison.OrdinalIgnoreCase) >= 0 || er.IndexOf("401", StringComparison.Ordinal) >= 0)
                    er = "O Instagram pediu login. Entre no Instagram neste Chrome e tente de novo. (" + er + ")";
                Reply(rid, false, er, null);
                return;
            }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["items"] = items;
            r["username"] = username;
            r["shortcode"] = shortcode;
            r["description"] = description != null && description.Length > 300 ? description.Substring(0, 300) + "…" : description;
            Reply(rid, true, null, r);
        }
        finally { TryDelete(cookieFile); }
    }

    // =============================================================
    //  Ferramentas de áudio e vídeo (ffmpeg)
    // =============================================================
    static double Num(Dictionary<string, object> m, string k, double def)
    {
        string v = Str(m, k);
        double d;
        return v != null && double.TryParse(v.Replace(',', '.'), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out d) ? d : def;
    }

    static string Inv(double d) { return d.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture); }

    static double ProbeDuration(string file)
    {
        try
        {
            StringBuilder err = new StringBuilder();
            int code;
            string o = Run(ffprobePath, new List<string> { "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file }, err, out code);
            double d;
            if (double.TryParse(o.Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) return d;
        }
        catch { }
        return 0;
    }

    static int ProbeHeight(string file)
    {
        try
        {
            StringBuilder err = new StringBuilder();
            int code, h;
            string o = Run(ffprobePath, new List<string> { "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", file }, err, out code);
            if (int.TryParse(o.Trim().Split('\n')[0].Trim(), out h)) return h;
        }
        catch { }
        return 0;
    }

    static string SafeName(string name)
    {
        foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        name = name.Replace(':', '_').Replace('*', '_').Replace('?', '_').Replace('"', '_').Replace('<', '_').Replace('>', '_').Replace('|', '_').Trim();
        if (name.Length > 120) name = name.Substring(0, 120);
        return name.Length == 0 ? "arquivo" : name;
    }

    static void Media(string rid, Dictionary<string, object> msg)
    {
        string job = Str(msg, "job") ?? Guid.NewGuid().ToString("N");
        string token = Str(msg, "token") ?? "";
        string op = Str(msg, "op") ?? "";
        Dictionary<string, object> prm = msg.ContainsKey("params") ? msg["params"] as Dictionary<string, object> : null;
        if (prm == null) prm = new Dictionary<string, object>();

        string input;
        lock (uploads) { if (uploads.TryGetValue(token, out input)) uploads.Remove(token); }
        if (input == null) { Reply(rid, false, "Arquivo não encontrado (envie de novo).", null); return; }

        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        string baseName = SafeName(Str(msg, "outName") ?? "arquivo");
        double duration = ProbeDuration(input);

        List<string> a = new List<string> { "-hide_banner", "-y", "-nostats", "-progress", "pipe:1" };
        string ext;
        double start = Num(prm, "start", 0), end = Num(prm, "end", 0);
        double outDuration = duration;

        if (op == "audio")
        {
            string fmt = Str(prm, "format") ?? "mp3";
            int br = (int)Num(prm, "bitrate", 192);
            if (br < 32 || br > 512) br = 192;
            a.AddRange(new[] { "-i", input, "-vn", "-map", "0:a:0" });
            if (fmt == "m4a") { ext = "m4a"; a.AddRange(new[] { "-c:a", "aac", "-b:a", br + "k" }); }
            else if (fmt == "wav") { ext = "wav"; a.AddRange(new[] { "-c:a", "pcm_s16le" }); }
            else if (fmt == "ogg") { ext = "ogg"; a.AddRange(new[] { "-c:a", "libopus", "-b:a", br + "k" }); }
            else { ext = "mp3"; a.AddRange(new[] { "-c:a", "libmp3lame", "-b:a", br + "k" }); }
        }
        else if (op == "convert")
        {
            ext = "mp4";
            a.AddRange(new[] { "-i", input, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart" });
        }
        else if (op == "compress")
        {
            ext = "mp4";
            string level = Str(prm, "level") ?? "media";
            double targetMB = Num(prm, "targetMB", 0);
            a.AddRange(new[] { "-i", input });
            int maxH = level == "forte" ? 720 : level == "leve" ? 1080 : 1080;
            if (ProbeHeight(input) > maxH) a.AddRange(new[] { "-vf", "scale=-2:" + maxH + ":flags=lanczos" });
            a.AddRange(new[] { "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p" });
            if (targetMB > 0 && duration > 0)
            {
                // cabe no tamanho escolhido (reserva 128 kbps para o áudio e 5% de margem)
                double kbps = Math.Max(150, (targetMB * 8192 * 0.95) / duration - 128);
                a.AddRange(new[] { "-b:v", ((int)kbps) + "k", "-maxrate", ((int)(kbps * 1.4)) + "k", "-bufsize", ((int)(kbps * 2)) + "k" });
            }
            else
            {
                a.AddRange(new[] { "-crf", level == "forte" ? "32" : level == "leve" ? "24" : "28" });
            }
            a.AddRange(new[] { "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart" });
        }
        else if (op == "trim")
        {
            if (end <= start) { Reply(rid, false, "O fim precisa ser depois do início.", null); TryDelete(input); return; }
            bool fast = Str(prm, "fast") == "true" || Str(prm, "fast") == "True";
            string inExt = Path.GetExtension(input).TrimStart('.').ToLowerInvariant();
            outDuration = end - start;
            a.AddRange(new[] { "-ss", Inv(start), "-i", input, "-t", Inv(outDuration) });
            if (fast) { ext = inExt.Length > 0 ? inExt : "mp4"; a.AddRange(new[] { "-c", "copy", "-avoid_negative_ts", "make_zero" }); }
            else { ext = "mp4"; a.AddRange(new[] { "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart" }); }
        }
        else if (op == "gif")
        {
            ext = "gif";
            int fps = (int)Num(prm, "fps", 12); if (fps < 1 || fps > 30) fps = 12;
            int width = (int)Num(prm, "width", 480); if (width < 64 || width > 1920) width = 480;
            if (end > start) { outDuration = end - start; a.AddRange(new[] { "-ss", Inv(start), "-t", Inv(outDuration) }); }
            a.AddRange(new[] { "-i", input, "-vf",
                "fps=" + fps + ",scale=" + width + ":-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5",
                "-loop", "0" });
        }
        else
        {
            TryDelete(input);
            Reply(rid, false, "Operação desconhecida: " + op, null);
            return;
        }

        string name = UniqueName(dir, baseName, new[] { "." + ext });
        string output = Path.Combine(dir, name + "." + ext);
        a.Add(output);

        Process p;
        try { p = Start(ffmpegPath, a); }
        catch (Exception e) { TryDelete(input); Reply(rid, false, "Não consegui abrir o ffmpeg: " + e.Message, null); return; }
        lock (jobs) { jobs[job] = p; }
        Dictionary<string, object> started = new Dictionary<string, object>();
        started["job"] = job;
        Reply(rid, true, null, started);

        StringBuilder errors = new StringBuilder();
        DateTime lastSent = DateTime.MinValue;
        p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e)
        {
            if (e.Data == null || !e.Data.StartsWith("out_time_us=")) return;
            long us;
            if (!long.TryParse(e.Data.Substring(12), out us) || outDuration <= 0) return;
            if ((DateTime.Now - lastSent).TotalMilliseconds < 300) return;
            lastSent = DateTime.Now;
            Dictionary<string, object> ev = new Dictionary<string, object>();
            ev["percent"] = Math.Min(99.0, Math.Max(0, us / 1e6 / outDuration * 100));
            Event(job, "progress", ev);
        };
        p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            lock (errors) { errors.AppendLine(e.Data); if (errors.Length > 20000) errors.Remove(0, 10000); }
        };
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        p.WaitForExit();

        bool wasCancelled;
        lock (jobs) { jobs.Remove(job); wasCancelled = cancelled.Remove(job); }
        lock (reserved) reserved.Remove(Path.Combine(dir, name));
        TryDelete(input);

        Dictionary<string, object> end2 = new Dictionary<string, object>();
        if (wasCancelled) { TryDelete(output); Event(job, "cancelled", end2); return; }
        if (p.ExitCode == 0 && File.Exists(output))
        {
            end2["file"] = output;
            end2["size"] = new FileInfo(output).Length;
            Event(job, "done", end2);
        }
        else
        {
            TryDelete(output);
            string[] lines = errors.ToString().Trim().Split('\n');
            string last = lines.Length > 0 ? lines[lines.Length - 1].Trim() : "";
            end2["error"] = "O ffmpeg não conseguiu processar este arquivo. " + last;
            Event(job, "error", end2);
        }
    }

    // ---------------- processos ----------------
    static ProcessStartInfo MakeInfo(List<string> args) { return MakeInfo(ytdlpPath, args); }

    static ProcessStartInfo MakeInfo(string exe, List<string> args)
    {
        ProcessStartInfo si = new ProcessStartInfo(exe, JoinArgs(args));
        si.UseShellExecute = false;
        si.CreateNoWindow = true;
        si.RedirectStandardOutput = true;
        si.RedirectStandardError = true;
        si.StandardOutputEncoding = Encoding.UTF8;
        si.StandardErrorEncoding = Encoding.UTF8;
        si.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        si.EnvironmentVariables["PYTHONUTF8"] = "1";
        // deixa o yt-dlp achar o ffmpeg e o deno da pasta bin
        string path = si.EnvironmentVariables["PATH"] ?? "";
        si.EnvironmentVariables["PATH"] = binDir + Path.PathSeparator + path;
        return si;
    }

    static Process Start(List<string> args) { return Start(ytdlpPath, args); }

    static Process Start(string exe, List<string> args)
    {
        Process p = new Process();
        p.StartInfo = MakeInfo(exe, args);
        p.Start();
        return p;
    }

    static string Run(List<string> args, StringBuilder err, out int code) { return Run(ytdlpPath, args, err, out code); }

    static string Run(string exe, List<string> args, StringBuilder err, out int code)
    {
        Process p = Start(exe, args);
        p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) lock (err) err.AppendLine(e.Data); };
        p.BeginErrorReadLine();
        string output = p.StandardOutput.ReadToEnd();
        p.WaitForExit();
        code = p.ExitCode;
        return output;
    }

    static string RunQuick(List<string> args)
    {
        try
        {
            StringBuilder err = new StringBuilder();
            int code;
            string o = Run(args, err, out code);
            return (o + err.ToString()).Trim();
        }
        catch (Exception e) { return "erro: " + e.Message; }
    }

    static void KillTree(Process p)
    {
        try
        {
            if (p.HasExited) return;
            if (IsWindows)
            {
                Process k = Process.Start(new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false });
                k.WaitForExit(5000);
            }
            else p.Kill();
        }
        catch { }
    }

    static string LastError(string text)
    {
        string last = null;
        foreach (string l in text.Split('\n'))
        {
            string t = l.Trim();
            if (t.StartsWith("ERROR:")) last = t.Substring(6).Trim();
        }
        if (last == null)
        {
            string trimmed = text.Trim();
            last = trimmed.Length > 300 ? trimmed.Substring(trimmed.Length - 300) : trimmed;
        }
        return string.IsNullOrEmpty(last) ? "Erro desconhecido no yt-dlp." : last;
    }

    // Monta a linha de comando seguindo as regras de aspas do Windows
    static string JoinArgs(List<string> args)
    {
        StringBuilder sb = new StringBuilder();
        foreach (string a in args)
        {
            if (sb.Length > 0) sb.Append(' ');
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { sb.Append(a); continue; }
            sb.Append('"');
            int bs = 0;
            foreach (char c in a)
            {
                if (c == '\\') { bs++; continue; }
                if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); }
                else { sb.Append('\\', bs); sb.Append(c); }
                bs = 0;
            }
            sb.Append('\\', bs * 2);
            sb.Append('"');
        }
        return sb.ToString();
    }
}
