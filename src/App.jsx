import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

const STORAGE_BUCKET = "gk-images";
const MAX_CABINETS = 10;
const MIN_CABINETS = 2;
const SHELVES = 3;
const SLOTS_PER_CABINET = 3;
const STORAGE_KEY = "gk-room-v5";
const SESSION_SPONSOR_KEY = "gkroom_sponsor_seen_v5";
const SESSION_SITE_AGE_KEY = "gkroom_site_age_ok_v5";
const SESSION_ADULT_GK_KEY = "gkroom_adult_gk_ok_v5";
const SESSION_SHARE_PROMPT_KEY = "gkroom_share_prompt_seen_v5";
const VISITOR_ID_KEY = "gkroom_visitor_id_v5";
const DYNAMIC_ENDPOINT = "dynamic-endpoint";

const ADMIN_EMAILS = String(import.meta?.env?.VITE_GK_ADMIN_EMAILS || "")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

const SPONSORS = [
  { name: "台灣奇行種", logo: "/sponsor-logo.png", url: "https://x.com/190CMMMM" },
  { name: "GK ROOM", logo: "/sponsor-logo-2.png", url: "https://x.com/190CMMMM" },
];

const DEFAULT_CABINET_BG = "linear-gradient(180deg,#2b1d14 0%,#8b5a2b 6%,#3b2518 8%,#21150f 100%)";

function emptyRack() {
  return Array.from({ length: SHELVES }, () => Array(MAX_CABINETS * SLOTS_PER_CABINET).fill(null));
}

function defaultPublicCabinets() {
  return Array.from({ length: MAX_CABINETS }, (_, i) => i < MIN_CABINETS);
}

function normalizePublicCabinets(value) {
  const base = defaultPublicCabinets();
  if (!Array.isArray(value)) return base;
  return base.map((v, i) => (typeof value[i] === "boolean" ? value[i] : v));
}

function safeCabinetCount(value) {
  const n = Number(value || MIN_CABINETS);
  return Math.max(MIN_CABINETS, Math.min(MAX_CABINETS, Number.isFinite(n) ? n : MIN_CABINETS));
}

function cabinetIndexFromSlot(slotIndex) {
  return Math.floor(Number(slotIndex || 0) / SLOTS_PER_CABINET);
}

function slotStart(cabinetIndex) {
  return cabinetIndex * SLOTS_PER_CABINET;
}

function cabinetName(index) {
  const zh = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  return `第${zh[index] || index + 1}櫃`;
}

function getShareRoomIdFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return p.get("room") || p.get("u") || "";
}

function buildShareUrl(userId) {
  if (!userId) return "";
  return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(userId)}`;
}

function isMobile() {
  return window.innerWidth < 820;
}

function itemId(item) {
  return item?.cloudId || item?.id || "";
}

function dbToItem(row) {
  return {
    id: row.id,
    cloudId: row.id,
    userId: row.user_id,
    name: row.name || "未命名 GK",
    studio: row.studio || "未填寫工作室",
    image: row.image || "",
    extraImages: Array.isArray(row.extra_images) ? row.extra_images : [],
    scale: Number(row.scale ?? 1),
    offsetX: Number(row.offset_x ?? 0),
    offsetY: Number(row.offset_y ?? 0),
    isSaved: Boolean(row.is_saved ?? true),
    bgRemoved: Boolean(row.bg_removed),
    isAdult: Boolean(row.is_adult),
    shelfIndex: Number(row.shelf_index || 0),
    slotIndex: Number(row.slot_index || 0),
    createdAt: row.created_at,
  };
}

function itemToDb(item, userId, shelfIndex, slotIndex) {
  return {
    user_id: userId,
    shelf_index: shelfIndex,
    slot_index: slotIndex,
    name: item.name || "未命名 GK",
    studio: item.studio || "未填寫工作室",
    image: item.image || "",
    extra_images: Array.isArray(item.extraImages) ? item.extraImages : [],
    scale: Number(item.scale ?? 1),
    offset_x: Number(item.offsetX ?? 0),
    offset_y: Number(item.offsetY ?? 0),
    is_saved: true,
    bg_removed: Boolean(item.bgRemoved),
    is_adult: Boolean(item.isAdult),
    updated_at: new Date().toISOString(),
  };
}

function rowsToRack(rows) {
  const next = emptyRack();
  for (const row of rows || []) {
    const s = Number(row.shelf_index || 0);
    const slot = Number(row.slot_index || 0);
    if (s >= 0 && s < SHELVES && slot >= 0 && slot < MAX_CABINETS * SLOTS_PER_CABINET) next[s][slot] = dbToItem(row);
  }
  return next;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, body] = String(dataUrl).split(",");
  const mime = header.match(/data:(.*?);/)?.[1] || "image/png";
  const bin = atob(body || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function resizeToWebp(dataUrl, max = 1600, quality = 0.82) {
  const img = await loadImage(dataUrl);
  const ratio = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/webp", quality);
}

async function simpleRemoveBg(dataUrl, tolerance = 78) {
  const img = await loadImage(dataUrl);
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, c.width, c.height);
  const d = imageData.data;
  const p = (x, y) => {
    const i = (y * c.width + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
  const bg = [p(0, 0), p(c.width - 1, 0), p(0, c.height - 1), p(c.width - 1, c.height - 1)]
    .reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0])
    .map((v) => v / 4);
  for (let i = 0; i < d.length; i += 4) {
    const diff = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
    if (diff < tolerance) d[i + 3] = 0;
  }
  ctx.putImageData(imageData, 0, 0);
  return c.toDataURL("image/png");
}

async function uploadToPublicStorage({ file, dataUrl, userId, folder = "main" }) {
  const blob = dataUrl ? dataUrlToBlob(dataUrl) : file;
  const name = String(file?.name || "gk").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
  const path = `${userId}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2)}-${name}.webp`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, blob, {
    cacheControl: "3600",
    upsert: false,
    contentType: blob.type || "image/webp",
  });
  if (error) throw error;
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("GK ROOM render error", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", background: "#05070b", color: "white", padding: 24, fontFamily: "Arial" }}>
          <div style={{ maxWidth: 720, margin: "60px auto", border: "1px solid #7f1d1d", borderRadius: 18, padding: 22, background: "rgba(127,29,29,.22)" }}>
            <h1 style={{ marginTop: 0 }}>GK ROOM 沒有黑屏，已攔截錯誤</h1>
            <p>請把下面錯誤截圖給我，不要再改 Supabase。</p>
            <pre style={{ whiteSpace: "pre-wrap", background: "#111827", padding: 14, borderRadius: 12 }}>{String(this.state.error?.message || this.state.error)}</pre>
            <button style={primaryButton()} onClick={() => { localStorage.clear(); sessionStorage.clear(); window.location.href = window.location.origin + window.location.pathname; }}>清除本機暫存並重新載入</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("mine");
  const [mobile, setMobile] = useState(isMobile());

  const [rack, setRack] = useState(emptyRack);
  const [publicRack, setPublicRack] = useState(emptyRack);
  const [selected, setSelected] = useState(null);
  const [publicSelected, setPublicSelected] = useState(null);
  const [rankingSelected, setRankingSelected] = useState(null);
  const [highlight, setHighlight] = useState("");

  const [cabinetCount, setCabinetCountState] = useState(() => safeCabinetCount(localStorage.getItem("gk_cabinet_count") || MIN_CABINETS));
  const [roomSettings, setRoomSettings] = useState({ public_cabinets: defaultPublicCabinets(), cabinet_count: MIN_CABINETS, is_public: true });
  const [profileName, setProfileName] = useState("GK玩家");
  const [publicRooms, setPublicRooms] = useState([]);
  const [viewingRoom, setViewingRoom] = useState(null);
  const [publicLoading, setPublicLoading] = useState(false);
  const [status, setStatus] = useState("");

  const [useFreeRemoveBg, setUseFreeRemoveBg] = useState(() => localStorage.getItem("useFreeRemoveBg") !== "false");
  const [bgTolerance, setBgTolerance] = useState(() => Number(localStorage.getItem("bgTolerance") || 78));
  const [processing, setProcessing] = useState(false);
  const [isEditingMeta, setIsEditingMeta] = useState(false);

  const [favoriteIds, setFavoriteIds] = useState(new Set());
  const [likedIds, setLikedIds] = useState(new Set());
  const [favoriteCounts, setFavoriteCounts] = useState({});
  const [likeCounts, setLikeCounts] = useState({});
  const [commentCounts, setCommentCounts] = useState({});
  const [comments, setComments] = useState([]);
  const [commentInput, setCommentInput] = useState("");
  const [favorites, setFavorites] = useState([]);
  const [topItems, setTopItems] = useState([]);
  const [latestItems, setLatestItems] = useState([]);

  const [visitorStats, setVisitorStats] = useState({ total: 0, online: 1 });
  const [sponsorOpen, setSponsorOpen] = useState(() => sessionStorage.getItem(SESSION_SPONSOR_KEY) !== "yes");
  const [sponsorCountdown, setSponsorCountdown] = useState(5);
  const [siteAgeOpen, setSiteAgeOpen] = useState(false);
  const [siteBlocked, setSiteBlocked] = useState(false);
  const [adultConfirmOpen, setAdultConfirmOpen] = useState(false);
  const [sharePromptOpen, setSharePromptOpen] = useState(() => Boolean(getShareRoomIdFromUrl()) && sessionStorage.getItem(SESSION_SHARE_PROMPT_KEY) !== "yes");

  const [adminItems, setAdminItems] = useState([]);
  const [adminReports, setAdminReports] = useState([]);
  const [adminMessage, setAdminMessage] = useState("");
  const [preview, setPreview] = useState({ images: [], index: 0 });

  const fileInputRef = useRef(null);
  const uploadTargetRef = useRef(null);
  const extraInputRef = useRef(null);

  const isAdmin = Boolean(user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase()));
  const isRanking = mode === "topFavorites" || mode === "latestFavorites";
  const activeRack = mode === "publicRoom" ? publicRack : rack;
  const activeSelected = isRanking ? rankingSelected : mode === "publicRoom" ? publicSelected : selected;
  const readOnly = mode === "publicRoom" || isRanking;
  const shareRoute = getShareRoomIdFromUrl();

  useEffect(() => {
    const onResize = () => setMobile(isMobile());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUser(data?.user || null);
      setAuthLoading(false);
    }).catch((e) => {
      console.error(e);
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      setAuthLoading(false);
    });
    return () => {
      mounted = false;
      data?.subscription?.unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!sponsorOpen) return;
    setSponsorCountdown(5);
    const t = setInterval(() => setSponsorCountdown((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [sponsorOpen]);

  useEffect(() => {
    trackVisitors();
    const t = setInterval(trackVisitors, 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (shareRoute) loadPublicRoomByUserId(shareRoute);
  }, [authLoading]);

  useEffect(() => {
    if (!user) {
      setRack(emptyRack());
      setSelected(null);
      return;
    }
    loadMyRoom(user.id);
    loadMySocialIds(user.id);
    loadSocialStats();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("admin") === "1") {
      setMode("admin");
      if (isAdmin) loadAdminPanel();
    }
  }, [user, isAdmin]);

  async function safeRun(label, fn) {
    try {
      return await fn();
    } catch (e) {
      console.error(label, e);
      setStatus(`${label}失敗：${e.message || "請檢查 Supabase 資料表 / RLS"}`);
      return null;
    }
  }

  async function signIn() {
    setLoginLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoginLoading(false);
    if (error) alert(error.message);
  }

  async function signUp() {
    setLoginLoading(true);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setLoginLoading(false);
    if (error) return alert(error.message);
    if (data?.user) await ensureProfileAndRoom(data.user);
    alert("註冊成功。如果有信箱驗證，請先到信箱確認。");
  }

  async function logout() {
    await supabase.auth.signOut();
    setMode("mine");
    setSelected(null);
  }

  async function ensureProfileAndRoom(u = user) {
    if (!u?.id) return;
    const name = u.email?.split("@")[0] || "GK玩家";
    await supabase.from("profiles").upsert({ id: u.id, username: name }, { onConflict: "id" });
    await supabase.from("gk_rooms").upsert({
      user_id: u.id,
      room_name: `${name} 的 GK ROOM`,
      is_public: true,
      public_cabinets: defaultPublicCabinets(),
      cabinet_count: MIN_CABINETS,
      public_left: true,
      public_right: true,
      public_third: false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  }

  async function loadMyRoom(userId) {
    await safeRun("載入展示間", async () => {
      await ensureProfileAndRoom({ id: userId, email: user?.email });
      const [{ data: profile }, { data: room }, { data: items }] = await Promise.all([
        supabase.from("profiles").select("username").eq("id", userId).maybeSingle(),
        supabase.from("gk_rooms").select("*").eq("user_id", userId).maybeSingle(),
        supabase.from("gk_items").select("*").eq("user_id", userId).order("shelf_index").order("slot_index"),
      ]);
      setProfileName(profile?.username || user?.email?.split("@")[0] || "GK玩家");
      const publicCabinets = normalizePublicCabinets(room?.public_cabinets || [room?.public_left, room?.public_right, room?.public_third]);
      const count = safeCabinetCount(room?.cabinet_count || MIN_CABINETS);
      setRoomSettings({ ...(room || {}), public_cabinets: publicCabinets, cabinet_count: count });
      setCabinetCountState(count);
      setRack(rowsToRack(items || []));
      setStatus("雲端展示間已同步");
    });
  }

  async function saveProfileName() {
    if (!user) return;
    const clean = profileName.trim() || "GK玩家";
    await safeRun("儲存展示名稱", async () => {
      await supabase.from("profiles").upsert({ id: user.id, username: clean }, { onConflict: "id" });
      await supabase.from("gk_rooms").upsert({ user_id: user.id, room_name: `${clean} 的 GK ROOM`, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      setProfileName(clean);
      setStatus("展示名稱已儲存");
    });
  }

  async function updateCabinetPrivacy(index, checked) {
    if (!user) return;
    const next = normalizePublicCabinets(roomSettings.public_cabinets);
    next[index] = checked;
    const payload = {
      public_cabinets: next,
      public_left: next[0],
      public_right: next[1],
      public_third: next[2],
      is_public: next.slice(0, cabinetCount).some(Boolean),
      updated_at: new Date().toISOString(),
    };
    setRoomSettings((r) => ({ ...r, ...payload }));
    await safeRun("儲存公開設定", async () => {
      await supabase.from("gk_rooms").upsert({ user_id: user.id, ...payload }, { onConflict: "user_id" });
      setStatus("公開設定已儲存");
    });
  }

  async function changeCabinetCount(nextCount) {
    if (!user) return;
    const count = safeCabinetCount(nextCount);
    setCabinetCountState(count);
    localStorage.setItem("gk_cabinet_count", String(count));
    await safeRun("儲存櫃數", async () => {
      await supabase.from("gk_rooms").upsert({ user_id: user.id, cabinet_count: count, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      setStatus("櫃數已儲存");
    });
  }

  async function trackVisitors() {
    try {
      let id = localStorage.getItem(VISITOR_ID_KEY);
      if (!id) {
        id = crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(VISITOR_ID_KEY, id);
      }
      await supabase.from("gk_visits").upsert({ visitor_id: id, last_seen: new Date().toISOString() }, { onConflict: "visitor_id" });
      const since = new Date(Date.now() - 90000).toISOString();
      const [{ count: total }, { count: online }] = await Promise.all([
        supabase.from("gk_visits").select("visitor_id", { count: "exact", head: true }),
        supabase.from("gk_visits").select("visitor_id", { count: "exact", head: true }).gte("last_seen", since),
      ]);
      setVisitorStats({ total: total || 0, online: online || 1 });
    } catch {
      setVisitorStats((s) => ({ total: s.total || 1, online: s.online || 1 }));
    }
  }

  function closeSponsorAd() {
    if (sponsorCountdown > 0) return;
    sessionStorage.setItem(SESSION_SPONSOR_KEY, "yes");
    setSponsorOpen(false);
    if (sessionStorage.getItem(SESSION_SITE_AGE_KEY) !== "yes") setSiteAgeOpen(true);
  }

  function acceptSiteAge() {
    sessionStorage.setItem(SESSION_SITE_AGE_KEY, "yes");
    setSiteAgeOpen(false);
    setSiteBlocked(false);
  }

  function rejectSiteAge() {
    setSiteBlocked(true);
    setSiteAgeOpen(false);
  }

  function adultLabelsHidden() {
    return sessionStorage.getItem(SESSION_ADULT_GK_KEY) === "yes";
  }

  function requireAdultForItem(item, unauthBlocked = false) {
    if (!item?.isAdult) return true;
    if (!user && unauthBlocked) {
      setSharePromptOpen(true);
      return false;
    }
    if (sessionStorage.getItem(SESSION_ADULT_GK_KEY) === "yes") return true;
    setAdultConfirmOpen(true);
    return false;
  }

  function confirmAdultGk() {
    sessionStorage.setItem(SESSION_ADULT_GK_KEY, "yes");
    setAdultConfirmOpen(false);
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    const target = uploadTargetRef.current;
    e.target.value = "";
    if (!file || !target || !user) return;
    setProcessing(true);
    try {
      setStatus("圖片處理中...");
      let dataUrl = await fileToDataUrl(file);
      let bgRemoved = false;
      if (mode === "mine" && useFreeRemoveBg) {
        dataUrl = await simpleRemoveBg(dataUrl, bgTolerance);
        bgRemoved = true;
      }
      dataUrl = await resizeToWebp(dataUrl);
      const url = await uploadToPublicStorage({ file, dataUrl, userId: user.id, folder: "main" });
      const local = {
        id: `local-${Date.now()}`,
        cloudId: null,
        userId: user.id,
        name: file.name.replace(/\.[^.]+$/, "") || "未命名 GK",
        studio: "未填寫工作室",
        image: url,
        extraImages: [],
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        isAdult: false,
        isSaved: false,
        bgRemoved,
        shelfIndex: target.shelfIndex,
        slotIndex: target.slotIndex,
      };
      setRack((old) => old.map((row, si) => row.map((it, sl) => (si === target.shelfIndex && sl === target.slotIndex ? local : it))));
      setSelected({ ...local, location: locationText(target.shelfIndex, target.slotIndex) });
      setIsEditingMeta(true);
      setStatus("圖片已上傳，請在右側填資料後按儲存 GK");
    } catch (err) {
      console.error(err);
      alert(`上傳失敗：${err.message || "請檢查 Storage bucket 是否 public / policy 是否允許 upload"}`);
    } finally {
      setProcessing(false);
    }
  }

  async function saveSelected() {
    if (!user || !selected) return;
    await safeRun("儲存 GK", async () => {
      const payload = itemToDb(selected, user.id, selected.shelfIndex, selected.slotIndex);
      let savedId = selected.cloudId;
      if (selected.cloudId) {
        const { error } = await supabase.from("gk_items").update(payload).eq("id", selected.cloudId).eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("gk_items").insert(payload).select("id").single();
        if (error) throw error;
        savedId = data.id;
      }
      const saved = { ...selected, id: savedId, cloudId: savedId, userId: user.id, isSaved: true };
      setSelected(saved);
      setRack((old) => old.map((row, si) => row.map((it, sl) => (si === selected.shelfIndex && sl === selected.slotIndex ? saved : it))));
      setIsEditingMeta(false);
      setStatus("GK 已儲存");
      loadSocialStats();
    });
  }

  async function deleteSelectedItem() {
    if (!user || !selected) return;
    if (!window.confirm(`確定刪除「${selected.name || "這隻 GK"}」？`)) return;
    await safeRun("刪除 GK", async () => {
      if (selected.cloudId) await supabase.from("gk_items").delete().eq("id", selected.cloudId).eq("user_id", user.id);
      setRack((old) => old.map((row, si) => row.map((it, sl) => (si === selected.shelfIndex && sl === selected.slotIndex ? null : it))));
      setSelected(null);
      setStatus("GK 已刪除");
    });
  }

  async function handleExtraUpload(e) {
    const files = Array.from(e.target.files || []).slice(0, 5);
    e.target.value = "";
    if (!user || !selected || !files.length) return;
    setProcessing(true);
    try {
      const urls = [];
      for (const file of files) {
        const dataUrl = await resizeToWebp(await fileToDataUrl(file));
        urls.push(await uploadToPublicStorage({ file, dataUrl, userId: user.id, folder: "details" }));
      }
      const next = [...(selected.extraImages || []), ...urls].slice(0, 5);
      patchSelected({ extraImages: next });
      setStatus("細節圖已上傳，記得按儲存 GK");
    } catch (e2) {
      alert("細節圖上傳失敗：" + (e2.message || ""));
    } finally {
      setProcessing(false);
    }
  }

  function patchSelected(patch) {
    if (!selected) return;
    const next = { ...selected, ...patch };
    setSelected(next);
    setRack((old) => old.map((row, si) => row.map((it, sl) => (si === next.shelfIndex && sl === next.slotIndex ? { ...it, ...patch } : it))));
  }

  function locationText(shelfIndex, slotIndex) {
    const c = cabinetIndexFromSlot(slotIndex);
    return `${cabinetName(c)} / 第 ${shelfIndex + 1} 層 / 第 ${(slotIndex % SLOTS_PER_CABINET) + 1} 格`;
  }

  function openUpload(shelfIndex, slotIndex) {
    if (mode !== "mine") return;
    uploadTargetRef.current = { shelfIndex, slotIndex };
    fileInputRef.current?.click();
  }

  function selectMineItem(item, shelfIndex, slotIndex) {
    if (!item) return;
    requireAdultForItem(item, false);
    setSelected({ ...item, shelfIndex, slotIndex, location: locationText(shelfIndex, slotIndex) });
    setIsEditingMeta(!item.isSaved);
    setHighlight(itemId(item));
    loadComments(itemId(item));
    setTimeout(() => setHighlight(""), 1200);
  }

  function selectPublicItem(item, shelfIndex, slotIndex) {
    if (!item) return;
    const ok = requireAdultForItem(item, true);
    if (!ok) return;
    setPublicSelected({ ...item, shelfIndex, slotIndex, location: locationText(shelfIndex, slotIndex) });
    setHighlight(itemId(item));
    loadComments(itemId(item));
    setTimeout(() => setHighlight(""), 1200);
  }

  async function loadPublicRooms() {
    setMode("explore");
    setViewingRoom(null);
    setPublicSelected(null);
    setPublicLoading(true);
    await safeRun("載入公開展櫃", async () => {
      const { data: rooms, error } = await supabase.from("gk_rooms").select("*").eq("is_public", true).order("updated_at", { ascending: false });
      if (error) throw error;
      const visible = (rooms || []).filter((r) => {
        const count = safeCabinetCount(r.cabinet_count);
        return normalizePublicCabinets(r.public_cabinets || [r.public_left, r.public_right, r.public_third]).slice(0, count).some(Boolean);
      });
      const ids = visible.map((r) => r.user_id).filter(Boolean);
      const [{ data: profiles }, { data: firstShelf }] = await Promise.all([
        ids.length ? supabase.from("profiles").select("id,username").in("id", ids) : Promise.resolve({ data: [] }),
        ids.length ? supabase.from("gk_items").select("*").in("user_id", ids).eq("shelf_index", 0).order("slot_index") : Promise.resolve({ data: [] }),
      ]);
      const pMap = new Map((profiles || []).map((p) => [p.id, p.username]));
      setPublicRooms(visible.map((room) => ({
        ...room,
        profileName: pMap.get(room.user_id) || "GK玩家",
        public_cabinets: normalizePublicCabinets(room.public_cabinets || [room.public_left, room.public_right, room.public_third]),
        cabinet_count: safeCabinetCount(room.cabinet_count),
        previewItems: (firstShelf || []).filter((it) => it.user_id === room.user_id),
      })));
    });
    setPublicLoading(false);
  }

  async function loadPublicRoomByUserId(ownerId) {
    if (!ownerId) return;
    setMode("publicRoom");
    setPublicLoading(true);
    setSharePromptOpen(!user && sessionStorage.getItem(SESSION_SHARE_PROMPT_KEY) !== "yes");
    await safeRun("載入分享頁", async () => {
      const [{ data: room, error: roomError }, { data: profile }, { data: items }] = await Promise.all([
        supabase.from("gk_rooms").select("*").eq("user_id", ownerId).eq("is_public", true).maybeSingle(),
        supabase.from("profiles").select("username").eq("id", ownerId).maybeSingle(),
        supabase.from("gk_items").select("*").eq("user_id", ownerId).order("shelf_index").order("slot_index"),
      ]);
      if (roomError) throw roomError;
      if (!room) throw new Error("找不到公開展示櫃，或對方尚未公開");
      const count = safeCabinetCount(room.cabinet_count);
      const publicCabinets = normalizePublicCabinets(room.public_cabinets || [room.public_left, room.public_right, room.public_third]);
      const visibleItems = (items || []).filter((it) => {
        const c = cabinetIndexFromSlot(it.slot_index);
        return c < count && publicCabinets[c];
      });
      setViewingRoom({ ...room, profileName: profile?.username || "GK玩家", public_cabinets: publicCabinets, cabinet_count: count });
      setPublicRack(rowsToRack(visibleItems));
      setPublicSelected(null);
    });
    setPublicLoading(false);
  }

  async function copyShareLink(ownerId = user?.id) {
    const url = buildShareUrl(ownerId);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setStatus("分享連結已複製");
    } catch {
      window.prompt("複製分享連結", url);
    }
  }

  async function loadMySocialIds(userId) {
    try {
      const [{ data: favs }, { data: likes }] = await Promise.all([
        supabase.from("gk_favorites").select("item_id").eq("user_id", userId),
        supabase.from("gk_likes").select("item_id").eq("user_id", userId),
      ]);
      setFavoriteIds(new Set((favs || []).map((x) => x.item_id)));
      setLikedIds(new Set((likes || []).map((x) => x.item_id)));
    } catch (e) {
      console.warn(e);
    }
  }

  async function loadSocialStats() {
    try {
      const [{ data: favs }, { data: likes }, { data: comms }, { data: latest }] = await Promise.all([
        supabase.from("gk_favorites").select("item_id,owner_id,created_at").limit(1000),
        supabase.from("gk_likes").select("item_id").limit(1000),
        supabase.from("gk_comments").select("item_id").limit(1000),
        supabase.from("gk_items").select("*").order("created_at", { ascending: false }).limit(20),
      ]);
      const fMap = {};
      const lMap = {};
      const cMap = {};
      (favs || []).forEach((x) => fMap[x.item_id] = (fMap[x.item_id] || 0) + 1);
      (likes || []).forEach((x) => lMap[x.item_id] = (lMap[x.item_id] || 0) + 1);
      (comms || []).forEach((x) => cMap[x.item_id] = (cMap[x.item_id] || 0) + 1);
      setFavoriteCounts(fMap);
      setLikeCounts(lMap);
      setCommentCounts(cMap);
      const topIds = Object.keys(fMap).sort((a, b) => fMap[b] - fMap[a]).slice(0, 20);
      const { data: topRows } = topIds.length ? await supabase.from("gk_items").select("*").in("id", topIds) : { data: [] };
      const sortedTop = topIds.map((id) => (topRows || []).find((x) => x.id === id)).filter(Boolean);
      setTopItems(sortedTop.map((r) => ({ item: dbToItem(r), favoriteCount: fMap[r.id] || 0, likeCount: lMap[r.id] || 0, commentCount: cMap[r.id] || 0 })));
      setLatestItems((latest || []).map((r) => ({ item: dbToItem(r), favoriteCount: fMap[r.id] || 0, likeCount: lMap[r.id] || 0, commentCount: cMap[r.id] || 0 })));
    } catch (e) {
      console.warn("social stats", e);
    }
  }

  async function loadFavorites() {
    if (!user) return;
    setMode("favorites");
    await safeRun("載入收藏", async () => {
      const { data: favs, error } = await supabase.from("gk_favorites").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
      if (error) throw error;
      const ids = (favs || []).map((f) => f.item_id);
      if (!ids.length) return setFavorites([]);
      const { data: items } = await supabase.from("gk_items").select("*").in("id", ids);
      const map = new Map((items || []).map((it) => [it.id, it]));
      setFavorites((favs || []).map((f) => map.get(f.item_id)).filter(Boolean).map(dbToItem));
    });
  }

  async function toggleLike(item) {
    if (!user || !itemId(item)) return alert("請先登入");
    const id = itemId(item);
    const liked = likedIds.has(id);
    await safeRun("按讚", async () => {
      if (liked) {
        await supabase.from("gk_likes").delete().eq("user_id", user.id).eq("item_id", id);
        setLikedIds((s) => { const n = new Set(s); n.delete(id); return n; });
        setLikeCounts((m) => ({ ...m, [id]: Math.max(0, (m[id] || 0) - 1) }));
      } else {
        await supabase.from("gk_likes").insert({ user_id: user.id, item_id: id, owner_id: item.userId });
        setLikedIds((s) => new Set([...s, id]));
        setLikeCounts((m) => ({ ...m, [id]: (m[id] || 0) + 1 }));
      }
    });
  }

  async function toggleFavorite(item) {
    if (!user || !itemId(item)) return alert("請先登入");
    if (item.userId === user.id) return alert("自己的 GK 不需要收藏");
    const id = itemId(item);
    const fav = favoriteIds.has(id);
    await safeRun("收藏", async () => {
      if (fav) {
        await supabase.from("gk_favorites").delete().eq("user_id", user.id).eq("item_id", id);
        setFavoriteIds((s) => { const n = new Set(s); n.delete(id); return n; });
      } else {
        await supabase.from("gk_favorites").insert({ user_id: user.id, item_id: id, owner_id: item.userId });
        setFavoriteIds((s) => new Set([...s, id]));
      }
      loadSocialStats();
    });
  }

  async function loadComments(id) {
    if (!id) return setComments([]);
    try {
      const { data: rows } = await supabase.from("gk_comments").select("id,item_id,user_id,body,created_at").eq("item_id", id).order("created_at", { ascending: true }).limit(100);
      const userIds = [...new Set((rows || []).map((r) => r.user_id).filter(Boolean))];
      const { data: profiles } = userIds.length ? await supabase.from("profiles").select("id,username").in("id", userIds) : { data: [] };
      const pMap = new Map((profiles || []).map((p) => [p.id, p.username]));
      setComments((rows || []).map((r) => ({ ...r, username: pMap.get(r.user_id) || "GK玩家" })));
    } catch (e) {
      console.warn(e);
      setComments([]);
    }
  }

  async function addComment(item) {
    if (!user) return alert("請先登入後留言");
    const id = itemId(item);
    if (!id || !commentInput.trim()) return;
    await safeRun("留言", async () => {
      await supabase.from("gk_comments").insert({ user_id: user.id, item_id: id, owner_id: item.userId, body: commentInput.trim() });
      setCommentInput("");
      setCommentCounts((m) => ({ ...m, [id]: (m[id] || 0) + 1 }));
      loadComments(id);
    });
  }

  async function resetAllData() {
    if (!user) return;
    if (!window.confirm("確定清空你的展示櫃？")) return;
    await safeRun("清空展示櫃", async () => {
      await supabase.from("gk_items").delete().eq("user_id", user.id);
      setRack(emptyRack());
      setSelected(null);
    });
  }

  async function loadAdminPanel() {
    if (!isAdmin) return;
    setAdminMessage("載入管理員資料中...");
    await safeRun("管理員資料", async () => {
      const [{ data: items }, { data: reports }] = await Promise.all([
        supabase.from("gk_items").select("*").order("created_at", { ascending: false }).limit(200),
        supabase.from("gk_reports").select("*").order("created_at", { ascending: false }).limit(100),
      ]);
      setAdminItems((items || []).map(dbToItem));
      setAdminReports(reports || []);
      setAdminMessage("管理員資料已更新");
    });
  }

  async function adminDeleteItem(target) {
    if (!isAdmin) return alert("沒有管理員權限");
    const id = typeof target === "string" ? target : itemId(target);
    if (!id || !window.confirm("管理員確認刪除此 GK？")) return;
    await safeRun("管理員刪除 GK", async () => {
      await supabase.from("gk_items").delete().eq("id", id);
      setAdminItems((list) => list.filter((x) => itemId(x) !== id));
      loadSocialStats();
    });
  }

  async function adminDeleteUser(targetUserId) {
    if (!isAdmin) return alert("沒有管理員權限");
    if (!targetUserId) return alert("缺少使用者 ID");
    if (targetUserId === user?.id) return alert("不能刪除目前登入的管理員帳號");
    if (!window.confirm("確認刪除此使用者？會清掉他的帳號與 GK 資料。")) return;
    await safeRun("管理員刪帳號", async () => {
      const { data, error } = await supabase.functions.invoke(DYNAMIC_ENDPOINT, { body: { action: "delete_user", user_id: targetUserId } });
      if (error || data?.error) throw error || new Error(data.error);
      setAdminItems((list) => list.filter((x) => x.userId !== targetUserId));
    });
  }

  async function adminResolveReport(id, status = "resolved") {
    if (!isAdmin) return;
    await safeRun("處理檢舉", async () => {
      await supabase.from("gk_reports").update({ status }).eq("id", id);
      setAdminReports((rs) => rs.map((r) => r.id === id ? { ...r, status } : r));
    });
  }

  if (authLoading) return <Loading />;
  if (siteBlocked) return <Blocked />;

  if (!user && !shareRoute) {
    return (
      <Shell mobile={mobile} left={<LoggedOutLeft visitorStats={visitorStats} />} center={<AuthScreen email={email} password={password} setEmail={setEmail} setPassword={setPassword} signIn={signIn} signUp={signUp} loading={loginLoading} />} right={null} />
    );
  }

  const left = (
    <LeftNav
      user={user}
      mode={mode}
      setMode={setMode}
      loadFavorites={loadFavorites}
      loadPublicRooms={loadPublicRooms}
      loadSocialStats={loadSocialStats}
      isAdmin={isAdmin}
      loadAdminPanel={loadAdminPanel}
      modeMineControls={mode === "mine" ? { useFreeRemoveBg, setUseFreeRemoveBg, bgTolerance, setBgTolerance, processing, status, resetAllData, loadMyRoom: () => loadMyRoom(user.id) } : null}
      logout={logout}
      visitorStats={visitorStats}
    />
  );

  let center;
  if (mode === "admin") center = <AdminPanel isAdmin={isAdmin} adminEmails={ADMIN_EMAILS} items={adminItems} reports={adminReports} message={adminMessage} onRefresh={loadAdminPanel} onDeleteItem={adminDeleteItem} onDeleteUser={adminDeleteUser} onResolveReport={adminResolveReport} onPreview={(src) => setPreview({ images: [src], index: 0 })} />;
  else if (mode === "explore") center = <ExploreView rooms={publicRooms} loading={publicLoading} onOpen={loadPublicRoomByUserId} onCopy={copyShareLink} />;
  else if (mode === "favorites") center = <FavoritesView favorites={favorites} onSelect={(it) => { setRankingSelected(it); setMode("latestFavorites"); loadComments(itemId(it)); }} onPreview={(src) => setPreview({ images: [src], index: 0 })} />;
  else if (mode === "topFavorites") center = <RankingView title="排行榜｜依收藏數排序" entries={topItems} onSelect={(entry) => { const it = entry.item; if (!requireAdultForItem(it, false)) return; setRankingSelected(it); loadComments(itemId(it)); }} />;
  else if (mode === "latestFavorites") center = <RankingView title="最新上架" entries={latestItems} onSelect={(entry) => { const it = entry.item; if (!requireAdultForItem(it, false)) return; setRankingSelected(it); loadComments(itemId(it)); }} />;
  else center = <ShowroomView rack={activeRack} readOnly={readOnly} highlight={highlight} onSlotClick={openUpload} onSelectItem={readOnly ? selectPublicItem : selectMineItem} cabinetCount={viewingRoom?.cabinet_count || cabinetCount} publicCabinets={viewingRoom?.public_cabinets || roomSettings.public_cabinets} updateCabinetPrivacy={mode === "mine" ? updateCabinetPrivacy : null} changeCabinetCount={mode === "mine" ? changeCabinetCount : null} viewingRoom={viewingRoom} adultLabelsHidden={adultLabelsHidden()} />;

  const right = (
    <RightPanel
      user={user}
      mode={mode}
      selected={activeSelected}
      profileName={profileName}
      setProfileName={setProfileName}
      saveProfileName={saveProfileName}
      copyShareLink={() => copyShareLink(mode === "publicRoom" ? viewingRoom?.user_id : user?.id)}
      shareUrl={buildShareUrl(mode === "publicRoom" ? viewingRoom?.user_id : user?.id)}
      isEditingMeta={isEditingMeta}
      setIsEditingMeta={setIsEditingMeta}
      patchSelected={patchSelected}
      saveSelected={saveSelected}
      deleteSelectedItem={deleteSelectedItem}
      extraInputRef={extraInputRef}
      comments={comments}
      commentInput={commentInput}
      setCommentInput={setCommentInput}
      addComment={addComment}
      toggleLike={toggleLike}
      toggleFavorite={toggleFavorite}
      liked={activeSelected ? likedIds.has(itemId(activeSelected)) : false}
      favorite={activeSelected ? favoriteIds.has(itemId(activeSelected)) : false}
      likeCount={activeSelected ? likeCounts[itemId(activeSelected)] || 0 : 0}
      favoriteCount={activeSelected ? favoriteCounts[itemId(activeSelected)] || 0 : 0}
      commentCount={activeSelected ? commentCounts[itemId(activeSelected)] || 0 : 0}
      readOnly={readOnly}
      isAdmin={isAdmin}
      adminDeleteItem={adminDeleteItem}
      adminDeleteUser={adminDeleteUser}
      onPreview={(images, index = 0) => setPreview({ images: Array.isArray(images) ? images : [images], index })}
      status={status}
    />
  );

  return (
    <>
      <Shell mobile={mobile} left={left} center={center} right={right} />
      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleUpload} />
      <input ref={extraInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleExtraUpload} />
      {sponsorOpen && <SponsorAd countdown={sponsorCountdown} onClose={closeSponsorAd} />}
      {!sponsorOpen && siteAgeOpen && <AgeGate onAccept={acceptSiteAge} onReject={rejectSiteAge} />}
      {adultConfirmOpen && <AdultConfirm onAccept={confirmAdultGk} onCancel={() => setAdultConfirmOpen(false)} />}
      {sharePromptOpen && <ShareLoginPrompt onClose={() => { sessionStorage.setItem(SESSION_SHARE_PROMPT_KEY, "yes"); setSharePromptOpen(false); }} />}
      {preview.images.length > 0 && <ImagePreview preview={preview} setPreview={setPreview} />}
    </>
  );
}

function Loading() {
  return <div style={{ minHeight: "100vh", background: "#05070b", color: "white", display: "grid", placeItems: "center", fontFamily: "Arial" }}>GK ROOM 載入中...</div>;
}

function Blocked() {
  return <div style={{ minHeight: "100vh", background: "#05070b", color: "white", display: "grid", placeItems: "center", fontFamily: "Arial", textAlign: "center" }}><div><h1>未滿 18 歲不可進入</h1><p style={{ color: "#9ca3af" }}>請關閉此頁面。</p></div></div>;
}

function Shell({ mobile, left, center, right }) {
  if (mobile) {
    return <div style={{ minHeight: "100vh", background: "#07090d", color: "white", fontFamily: "Arial", display: "flex", flexDirection: "column" }}><div>{left}</div><div style={{ flex: 1 }}>{center}</div>{right && <div>{right}</div>}</div>;
  }
  return <div style={{ height: "100vh", overflow: "hidden", background: "#07090d", color: "white", fontFamily: "Arial", display: "grid", gridTemplateColumns: "240px minmax(0,1fr) 310px" }}><aside style={asideStyle()}>{left}</aside><main style={{ overflow: "auto" }}>{center}</main><aside style={rightAsideStyle()}>{right}</aside></div>;
}

function AuthScreen({ email, password, setEmail, setPassword, signIn, signUp, loading }) {
  return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 22, background: "radial-gradient(circle at top,#1e1b4b,#05070b 55%)" }}><div style={{ width: "min(420px,92vw)", ...panelBox(), padding: 24 }}><h1 style={{ marginTop: 0 }}>GK ROOM</h1><p style={{ color: "#a5b4fc" }}>登入你的電子 GK 展示櫃</p><input style={inputStyle()} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} /><input style={inputStyle()} placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /><button style={{ ...primaryButton(), width: "100%" }} disabled={loading} onClick={signIn}>{loading ? "處理中" : "登入"}</button><button style={{ ...secondaryButton(), width: "100%", marginTop: 10 }} disabled={loading} onClick={signUp}>註冊新帳號</button></div></div>;
}

function LoggedOutLeft({ visitorStats }) {
  return <div style={{ padding: 14 }}><Logo /><SponsorCard /><VisitorStats stats={visitorStats} /></div>;
}

function LeftNav({ user, mode, setMode, loadFavorites, loadPublicRooms, loadSocialStats, isAdmin, loadAdminPanel, modeMineControls, logout, visitorStats }) {
  return <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", gap: 10 }}><Logo /><button style={navButton(mode === "mine")} onClick={() => setMode("mine")}>我的展示間</button><button style={navButton(mode === "favorites")} onClick={loadFavorites}>收藏管理</button><button style={navButton(mode === "explore" || mode === "publicRoom")} onClick={loadPublicRooms}>公開展櫃</button><button style={navButton(mode === "topFavorites")} onClick={() => { setMode("topFavorites"); loadSocialStats(); }}>排行榜</button><button style={navButton(mode === "latestFavorites")} onClick={() => { setMode("latestFavorites"); loadSocialStats(); }}>最新上架</button>{isAdmin && <button style={navButton(mode === "admin")} onClick={() => { setMode("admin"); loadAdminPanel(); }}>管理員</button>}<div style={{ marginTop: "auto" }}>{modeMineControls && <FreeBgPanel {...modeMineControls} />}<SponsorCard />{user && <button style={{ ...secondaryButton(), width: "100%", marginTop: 10 }} onClick={logout}>登出</button>}<VisitorStats stats={visitorStats} /></div></div>;
}

function Logo() {
  return <div style={{ marginBottom: 12 }}><div style={{ fontSize: 24, fontWeight: 950, lineHeight: 1.1 }}>GK<br />ROOM</div><div style={{ color: "#9ca3af", fontSize: 12, marginTop: 5 }}>電子展示櫃</div></div>;
}

function FreeBgPanel({ useFreeRemoveBg, setUseFreeRemoveBg, bgTolerance, setBgTolerance, processing, status, resetAllData, loadMyRoom }) {
  return <div style={{ ...panelBox(), marginBottom: 10 }}><div style={{ fontWeight: 900, marginBottom: 8 }}>免費去背</div><label style={smallRow()}><input type="checkbox" checked={useFreeRemoveBg} onChange={(e) => { localStorage.setItem("useFreeRemoveBg", e.target.checked ? "true" : "false"); setUseFreeRemoveBg(e.target.checked); }} />上傳時自動去背</label><div style={{ fontSize: 12, color: "#cbd5e1", marginTop: 8 }}>去背強度：{bgTolerance}</div><input type="range" min="35" max="130" value={bgTolerance} onChange={(e) => { localStorage.setItem("bgTolerance", e.target.value); setBgTolerance(Number(e.target.value)); }} style={{ width: "100%" }} /><button style={{ ...secondaryButton(), width: "100%", marginTop: 8 }} onClick={loadMyRoom}>重新同步雲端</button><button style={{ ...dangerButton(), width: "100%", marginTop: 8 }} onClick={resetAllData}>清空雲端資料</button>{status && <div style={{ color: processing ? "#93c5fd" : "#86efac", fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>{status}</div>}</div>;
}

function SponsorCard() {
  const [idx, setIdx] = useState(0);
  useEffect(() => { const t = setInterval(() => setIdx((i) => (i + 1) % SPONSORS.length), 3000); return () => clearInterval(t); }, []);
  const s = SPONSORS[idx] || SPONSORS[0];
  return <button style={{ ...panelBox(), width: "100%", textAlign: "left", cursor: "pointer", marginTop: 10 }} onClick={() => window.open(s.url, "_blank", "noopener,noreferrer")}><div style={{ fontSize: 12, color: "#facc15", fontWeight: 900 }}>贊助商</div><div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}><img src={s.logo} onError={(e) => { e.currentTarget.style.display = "none"; }} style={{ width: 42, height: 42, objectFit: "contain", borderRadius: 10, background: "#111827" }} /><div style={{ fontWeight: 900 }}>{s.name}</div></div></button>;
}

function VisitorStats({ stats }) {
  return <div style={{ ...panelBox(), marginTop: 10, fontSize: 12, color: "#cbd5e1", lineHeight: 1.7 }}><div>總共來 GKROOM：<b>{stats.total}</b></div><div>目前線上人數：<b>{stats.online}</b></div></div>;
}

function ShowroomView({ rack, readOnly, highlight, onSlotClick, onSelectItem, cabinetCount, publicCabinets, updateCabinetPrivacy, changeCabinetCount, viewingRoom, adultLabelsHidden }) {
  const cabinets = Array.from({ length: cabinetCount }, (_, i) => i).filter((i) => !readOnly || publicCabinets[i]);
  return <div style={{ padding: 18 }}><div style={{ maxWidth: 1240, margin: "0 auto" }}>{viewingRoom && <div style={{ ...panelBox(), marginBottom: 12, fontWeight: 900 }}>{viewingRoom.profileName || viewingRoom.room_name || "公開展示櫃"}</div>}<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(310px,1fr))", gap: 16 }}>{cabinets.map((ci) => <Cabinet key={ci} index={ci} rack={rack} readOnly={readOnly} checked={publicCabinets[ci]} highlight={highlight} onPrivacy={updateCabinetPrivacy} onAdd={() => changeCabinetCount?.(cabinetCount + 1)} onRemove={() => changeCabinetCount?.(cabinetCount - 1)} onSlotClick={onSlotClick} onSelectItem={onSelectItem} adultLabelsHidden={adultLabelsHidden} />)}</div></div></div>;
}

function Cabinet({ index, rack, readOnly, checked, highlight, onPrivacy, onAdd, onRemove, onSlotClick, onSelectItem, adultLabelsHidden }) {
  return <section style={{ border: "1px solid rgba(255,255,255,.12)", borderRadius: 18, overflow: "hidden", background: "#0b0f16", boxShadow: "0 18px 44px rgba(0,0,0,.35)" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "rgba(255,255,255,.04)" }}><b>{cabinetName(index)}</b>{!readOnly && <div style={{ display: "flex", alignItems: "center", gap: 8 }}><label style={{ fontSize: 12 }}><input type="checkbox" checked={!!checked} onChange={(e) => onPrivacy?.(index, e.target.checked)} />公開</label><button style={miniBtn()} onClick={onAdd}>＋</button><button style={miniBtn()} onClick={onRemove}>－</button></div>}</div><div style={{ background: DEFAULT_CABINET_BG, padding: 12 }}>{Array.from({ length: SHELVES }, (_, shelf) => <div key={shelf} style={{ display: "grid", gridTemplateColumns: `repeat(${SLOTS_PER_CABINET},1fr)`, gap: 10, padding: "10px 0", borderBottom: shelf < SHELVES - 1 ? "8px solid rgba(116,70,30,.85)" : "0" }}>{Array.from({ length: SLOTS_PER_CABINET }, (_, pos) => { const slot = slotStart(index) + pos; const item = rack?.[shelf]?.[slot]; return <div key={slot} onClick={() => item ? onSelectItem?.(item, shelf, slot) : onSlotClick?.(shelf, slot)} style={slotCell()}>{item ? <GKItem item={item} highlighted={highlight === itemId(item)} hideAdultLabel={adultLabelsHidden} /> : !readOnly && <span style={{ color: "#9ca3af", fontSize: 32 }}>＋</span>}</div>; })}</div>)}</div></section>;
}

function GKItem({ item, highlighted, hideAdultLabel }) {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  return <div onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setTilt({ x: ((e.clientY - r.top) / r.height - .5) * -10, y: ((e.clientX - r.left) / r.width - .5) * 14 }); }} onMouseLeave={() => setTilt({ x: 0, y: 0 })} style={{ position: "relative", width: "100%", height: "100%", perspective: 800, cursor: "pointer" }}><img src={item.image} alt={item.name || "GK"} style={{ width: "100%", height: "100%", objectFit: "contain", transform: `translate(${item.offsetX || 0}px,${item.offsetY || 0}px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale(${highlighted ? (item.scale || 1) * 1.06 : item.scale || 1})`, transition: "transform .12s ease, filter .16s ease", filter: highlighted ? "drop-shadow(0 0 18px #60a5fa) drop-shadow(0 12px 20px rgba(0,0,0,.55))" : "drop-shadow(0 10px 16px rgba(0,0,0,.45))" }} />{item.isAdult && !hideAdultLabel && <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", background: "rgba(0,0,0,.82)", color: "white", borderRadius: 999, padding: "8px 16px", fontSize: 22, fontWeight: 950, pointerEvents: "none" }}>18+</div>}</div>;
}

function ExploreView({ rooms, loading, onOpen, onCopy }) {
  if (loading) return <CenterMessage text="公開展櫃載入中..." />;
  if (!rooms.length) return <CenterMessage text="目前還沒有公開展櫃" />;
  return <div style={{ padding: 18 }}><h2>公開展櫃</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>{rooms.map((room) => <div key={room.user_id} style={panelBox()}><div style={{ fontWeight: 950, marginBottom: 10 }}>{room.profileName || room.room_name || "GK玩家"}</div><MiniShelfPreview room={room} /><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}><button style={primaryButton()} onClick={() => onOpen(room.user_id)}>進入</button><button style={secondaryButton()} onClick={() => onCopy(room.user_id)}>分享</button></div></div>)}</div></div>;
}

function MiniShelfPreview({ room }) {
  const publicCabinets = normalizePublicCabinets(room.public_cabinets);
  const firstPublic = publicCabinets.findIndex(Boolean);
  const items = (room.previewItems || []).filter((it) => cabinetIndexFromSlot(it.slot_index) === firstPublic).slice(0, 3);
  return <div style={{ height: 150, borderRadius: 14, overflow: "hidden", background: DEFAULT_CABINET_BG, padding: 12, border: "1px solid rgba(255,255,255,.1)" }}><div style={{ height: "100%", display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, borderBottom: "8px solid rgba(116,70,30,.85)" }}>{[0, 1, 2].map((i) => <div key={i} style={{ display: "grid", placeItems: "end center" }}>{items[i]?.image ? <img src={items[i].image} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", filter: "drop-shadow(0 10px 14px rgba(0,0,0,.5))" }} /> : <span style={{ color: "rgba(255,255,255,.25)" }}>空</span>}</div>)}</div></div>;
}

function RankingView({ title, entries, onSelect }) {
  return <div style={{ padding: 18 }}><h2>{title}</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 14 }}>{entries.map((e, i) => <div key={itemId(e.item) || i} style={panelBox()} onClick={() => onSelect(e)}><div style={{ color: "#facc15", fontWeight: 900 }}>#{i + 1} 收藏 {e.favoriteCount || 0}</div><img src={e.item.image} style={{ width: "100%", height: 180, objectFit: "contain", marginTop: 8 }} /><b>{e.item.name}</b><div style={{ color: "#9ca3af", fontSize: 12 }}>讚 {e.likeCount || 0}｜留言 {e.commentCount || 0}</div></div>)}</div></div>;
}

function FavoritesView({ favorites, onSelect, onPreview }) {
  if (!favorites.length) return <CenterMessage text="目前沒有收藏" />;
  return <div style={{ padding: 18 }}><h2>收藏管理</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 14 }}>{favorites.map((it) => <div key={itemId(it)} style={panelBox()} onClick={() => onSelect(it)}><img src={it.image} style={{ width: "100%", height: 180, objectFit: "contain" }} /><b>{it.name}</b><button style={{ ...secondaryButton(), width: "100%", marginTop: 8 }} onClick={(e) => { e.stopPropagation(); onPreview(it.image); }}>看大圖</button></div>)}</div></div>;
}

function AdminPanel({ isAdmin, adminEmails, items, reports, message, onRefresh, onDeleteItem, onDeleteUser, onResolveReport, onPreview }) {
  if (!isAdmin) return <CenterMessage text={`不是管理員。請在 Vercel 環境變數設定 VITE_GK_ADMIN_EMAILS。現在讀到：${adminEmails.length ? adminEmails.join(",") : "空白"}`} />;
  return <div style={{ padding: 18 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}><h2>管理員模式</h2><button style={primaryButton()} onClick={onRefresh}>重新整理</button></div>{message && <div style={{ ...panelBox(), marginBottom: 12 }}>{message}</div>}<h3>檢舉資料</h3><div style={{ display: "grid", gap: 8 }}>{reports.length ? reports.map((r) => <div key={r.id} style={panelBox()}><div>狀態：{r.status || "pending"}</div><div style={{ color: "#cbd5e1", fontSize: 13 }}>{r.reason || r.body || "無內容"}</div><button style={secondaryButton()} onClick={() => onResolveReport(r.id, "resolved")}>標記已處理</button></div>) : <div style={panelBox()}>目前沒有檢舉</div>}</div><h3>最新 GK</h3><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12 }}>{items.map((it) => <div key={itemId(it)} style={panelBox()}><img src={it.image} style={{ width: "100%", height: 160, objectFit: "contain" }} onClick={() => onPreview(it.image)} /><b>{it.name}</b><div style={{ color: "#9ca3af", fontSize: 12 }}>Owner：{it.userId}</div><button style={{ ...dangerButton(), width: "100%", marginTop: 8 }} onClick={() => onDeleteItem(it)}>刪除 GK</button><button style={{ ...dangerButton(), width: "100%", marginTop: 8 }} onClick={() => onDeleteUser(it.userId)}>刪除此帳號</button></div>)}</div></div>;
}

function RightPanel(props) {
  const { user, mode, selected, profileName, setProfileName, saveProfileName, copyShareLink, shareUrl, isEditingMeta, setIsEditingMeta, patchSelected, saveSelected, deleteSelectedItem, extraInputRef, comments, commentInput, setCommentInput, addComment, toggleLike, toggleFavorite, liked, favorite, likeCount, favoriteCount, commentCount, readOnly, isAdmin, adminDeleteItem, adminDeleteUser, onPreview, status } = props;
  return <div><div style={panelBox()}><div style={{ fontWeight: 950, marginBottom: 8 }}>收藏狀態</div><div style={{ color: "#cbd5e1", fontSize: 13 }}>讚 {likeCount}｜收藏 {favoriteCount}｜留言 {commentCount}</div><button style={{ ...secondaryButton(), width: "100%", marginTop: 8 }} onClick={copyShareLink}>分享連結</button>{mode === "mine" && <><input style={inputStyle()} value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="展示名稱" /><button style={{ ...primaryButton(), width: "100%" }} onClick={saveProfileName}>儲存名稱</button></>}<div style={{ color: "#6b7280", fontSize: 11, wordBreak: "break-all", marginTop: 8 }}>{shareUrl}</div>{status && <div style={{ color: "#86efac", fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>{status}</div>}</div><div style={{ ...panelBox(), marginTop: 12 }}>{!selected ? <div style={{ color: "#9ca3af" }}>尚未選擇 GK</div> : <><div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><h3 style={{ marginTop: 0 }}>GK 詳細資訊</h3>{selected.isAdult && <b style={{ color: "#fca5a5" }}>18+</b>}</div><img src={selected.image} style={{ width: "100%", maxHeight: 260, objectFit: "contain", cursor: "pointer" }} onClick={() => onPreview([selected.image, ...(selected.extraImages || [])], 0)} />{isEditingMeta && !readOnly ? <EditForm selected={selected} patchSelected={patchSelected} saveSelected={saveSelected} extraInputRef={extraInputRef} /> : <Info selected={selected} />}{!readOnly && <button style={{ ...secondaryButton(), width: "100%", marginTop: 8 }} onClick={() => setIsEditingMeta(true)}>重新編輯資料</button>}{!readOnly && <button style={{ ...dangerButton(), width: "100%", marginTop: 8 }} onClick={deleteSelectedItem}>刪除此 GK</button>}{readOnly && user && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}><button style={{ ...primaryButton(), background: liked ? "#be123c" : "#374151" }} onClick={() => toggleLike(selected)}>{liked ? "❤️ 已讚" : "♡ 讚"}</button><button style={{ ...primaryButton(), background: favorite ? "#7c3aed" : "#2563eb" }} onClick={() => toggleFavorite(selected)}>{favorite ? "⭐ 已收藏" : "☆ 收藏"}</button></div>}{isAdmin && selected.userId && <button style={{ ...dangerButton(), width: "100%", marginTop: 8 }} onClick={() => adminDeleteUser(selected.userId)}>管理員刪除此帳號</button>}{isAdmin && itemId(selected) && <button style={{ ...dangerButton(), width: "100%", marginTop: 8 }} onClick={() => adminDeleteItem(selected)}>管理員刪除 GK</button>}<Comments comments={comments} input={commentInput} setInput={setCommentInput} onSubmit={() => addComment(selected)} user={user} /></>}</div></div>;
}

function EditForm({ selected, patchSelected, saveSelected, extraInputRef }) {
  return <div><input style={inputStyle()} value={selected.name || ""} onChange={(e) => patchSelected({ name: e.target.value })} placeholder="GK 名稱" /><input style={inputStyle()} value={selected.studio || ""} onChange={(e) => patchSelected({ studio: e.target.value })} placeholder="工作室" /><label style={smallRow()}><input type="checkbox" checked={!!selected.isAdult} onChange={(e) => patchSelected({ isAdult: e.target.checked })} />標記 is_adult / 18+</label><Slider label="大小" value={selected.scale || 1} min="0.5" max="1.8" step="0.01" onChange={(v) => patchSelected({ scale: v })} /><Slider label="左右" value={selected.offsetX || 0} min="-60" max="60" step="1" onChange={(v) => patchSelected({ offsetX: v })} /><Slider label="上下" value={selected.offsetY || 0} min="-60" max="60" step="1" onChange={(v) => patchSelected({ offsetY: v })} /><button style={{ ...secondaryButton(), width: "100%", marginTop: 8 }} onClick={() => extraInputRef.current?.click()}>上傳細節圖</button><button style={{ ...primaryButton(), width: "100%", marginTop: 8 }} onClick={saveSelected}>儲存 GK</button></div>;
}

function Info({ selected }) {
  return <div style={{ color: "#cbd5e1", fontSize: 14, lineHeight: 1.7 }}><div><b>{selected.name}</b></div><div>工作室：{selected.studio}</div><div>位置：{selected.location || "未指定"}</div><div>18+：{selected.isAdult ? "是" : "否"}</div></div>;
}

function Slider({ label, value, min, max, step, onChange }) {
  return <label style={{ display: "block", fontSize: 12, color: "#cbd5e1", marginTop: 8 }}>{label}：{value}<input style={{ width: "100%" }} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}

function Comments({ comments, input, setInput, onSubmit, user }) {
  return <div style={{ marginTop: 14 }}><div style={{ fontWeight: 900, marginBottom: 8 }}>留言內容</div><div style={{ display: "grid", gap: 8 }}>{comments.length ? comments.map((c) => <div key={c.id} style={{ background: "#111827", borderRadius: 10, padding: 9 }}><div style={{ color: "#93c5fd", fontSize: 12 }}>{c.username || "GK玩家"}</div><div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div></div>) : <div style={{ color: "#6b7280", fontSize: 13 }}>尚無留言</div>}</div>{user ? <div style={{ display: "flex", gap: 8, marginTop: 8 }}><input style={{ ...inputStyle(), margin: 0 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="輸入留言" /><button style={primaryButton()} onClick={onSubmit}>送出</button></div> : <div style={{ color: "#9ca3af", fontSize: 12, marginTop: 8 }}>登入後可留言</div>}</div>;
}

function SponsorAd({ countdown, onClose }) {
  return <Modal><div style={{ ...panelBox(), width: "min(460px,92vw)", textAlign: "center", padding: 24 }}><h2>贊助商廣告</h2><SponsorCard /><p style={{ color: "#cbd5e1" }}>感謝贊助 GK ROOM</p><button style={{ ...primaryButton(), width: "100%", opacity: countdown > 0 ? .6 : 1 }} disabled={countdown > 0} onClick={onClose}>{countdown > 0 ? `${countdown} 秒後可關閉` : "關閉廣告"}</button></div></Modal>;
}

function AgeGate({ onAccept, onReject }) {
  return <Modal><div style={{ ...panelBox(), width: "min(460px,92vw)", textAlign: "center", padding: 24 }}><h2>是否已滿 18 歲？</h2><p style={{ color: "#cbd5e1" }}>進入 GK ROOM 前請確認年齡。</p><button style={{ ...primaryButton(), width: "100%" }} onClick={onAccept}>我已滿十八歲，進入</button><button style={{ ...dangerButton(), width: "100%", marginTop: 10 }} onClick={onReject}>未滿十八歲，離開</button></div></Modal>;
}

function AdultConfirm({ onAccept, onCancel }) {
  return <Modal><div style={{ ...panelBox(), width: "min(420px,92vw)", padding: 22, textAlign: "center" }}><h2>此 GK 標記為 18+</h2><p style={{ color: "#cbd5e1" }}>是否確認已滿 18 歲？同一瀏覽器 session 只會詢問一次。</p><button style={{ ...primaryButton(), width: "100%" }} onClick={onAccept}>我已滿 18 歲</button><button style={{ ...secondaryButton(), width: "100%", marginTop: 10 }} onClick={onCancel}>取消</button></div></Modal>;
}

function ShareLoginPrompt({ onClose }) {
  return <Modal><div style={{ ...panelBox(), width: "min(420px,92vw)", padding: 22, textAlign: "center" }}><h2>登入後可觀看完整 GK（含 18+）</h2><p style={{ color: "#cbd5e1" }}>未登入仍可觀看櫃子與一般 GK；18+ GK 需登入後確認年齡。</p><button style={{ ...primaryButton(), width: "100%" }} onClick={onClose}>我知道了</button></div></Modal>;
}

function ImagePreview({ preview, setPreview }) {
  const img = preview.images[preview.index] || preview.images[0];
  return <Modal><div style={{ maxWidth: "92vw", maxHeight: "92vh", position: "relative" }}><button style={{ ...dangerButton(), position: "absolute", right: 0, top: -48 }} onClick={() => setPreview({ images: [], index: 0 })}>關閉</button><img src={img} style={{ maxWidth: "92vw", maxHeight: "86vh", objectFit: "contain" }} /></div></Modal>;
}

function Modal({ children }) {
  return <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.76)", display: "grid", placeItems: "center", padding: 18 }}>{children}</div>;
}

function CenterMessage({ text }) {
  return <div style={{ minHeight: "70vh", display: "grid", placeItems: "center", color: "#9ca3af" }}>{text}</div>;
}

function asideStyle() { return { overflow: "auto", borderRight: "1px solid rgba(255,255,255,.09)", padding: 14, boxSizing: "border-box", background: "#080b11" }; }
function rightAsideStyle() { return { overflow: "auto", borderLeft: "1px solid rgba(255,255,255,.09)", padding: 14, boxSizing: "border-box", background: "#080b11" }; }
function panelBox() { return { border: "1px solid rgba(255,255,255,.11)", background: "rgba(15,23,42,.72)", borderRadius: 16, padding: 12, boxShadow: "0 16px 36px rgba(0,0,0,.25)" }; }
function primaryButton() { return { border: 0, borderRadius: 12, background: "#2563eb", color: "white", padding: "10px 12px", fontWeight: 900, cursor: "pointer" }; }
function secondaryButton() { return { border: "1px solid rgba(255,255,255,.16)", borderRadius: 12, background: "#111827", color: "white", padding: "10px 12px", fontWeight: 800, cursor: "pointer" }; }
function dangerButton() { return { border: 0, borderRadius: 12, background: "#991b1b", color: "white", padding: "10px 12px", fontWeight: 900, cursor: "pointer" }; }
function navButton(active) { return { ...secondaryButton(), width: "100%", textAlign: "left", background: active ? "#1d4ed8" : "#111827", marginBottom: 8 }; }
function inputStyle() { return { width: "100%", boxSizing: "border-box", margin: "8px 0", borderRadius: 12, border: "1px solid rgba(255,255,255,.14)", background: "#020617", color: "white", padding: "11px 12px", outline: "none" }; }
function smallRow() { return { display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1", fontSize: 13 }; }
function miniBtn() { return { width: 28, height: 28, borderRadius: 9, border: "1px solid rgba(255,255,255,.18)", background: "#111827", color: "white", fontWeight: 900, cursor: "pointer" }; }
function slotCell() { return { height: 130, minWidth: 0, borderRadius: 12, background: "rgba(0,0,0,.22)", border: "1px dashed rgba(255,255,255,.12)", display: "grid", placeItems: "center", overflow: "visible" }; }
