import React, { useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

const DOUBLE_RACK_IMAGE = "/double-rack-ui.png";
const MOBILE_RACK_IMAGE = "/single-rack-ui.png";
const STORAGE_BUCKET = "gk-images";
const RACK_ASPECT = 1536 / 1024;
const STORAGE_KEY = "gk-room-rack-v2";
const MAX_CABINETS = 10;
const SLOTS_PER_CABINET = 3;
const MIN_CABINETS = 2;

function defaultPublicCabinets() {
  return Array.from({ length: MAX_CABINETS }, (_, index) => index < MIN_CABINETS);
}

function normalizePublicCabinets(value) {
  const fallback = defaultPublicCabinets();
  if (!Array.isArray(value)) return fallback;
  return fallback.map((item, index) => typeof value[index] === "boolean" ? value[index] : item);
}

function cabinetTitle(index) {
  return `${numberToZh(index + 1)}櫃${index >= MIN_CABINETS ? "｜加購測試" : ""}`;
}

function numberToZh(num) {
  const list = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  return list[num - 1] || String(num);
}

function cabinetIndexFromSlot(slotIndex) {
  return Math.floor(slotIndex / SLOTS_PER_CABINET);
}

function slotStartByCabinet(index) {
  return index * SLOTS_PER_CABINET;
}

const LEFT_COLUMNS = [19.8, 31.1, 42.4];
const RIGHT_COLUMNS = [57.8, 69.1, 80.4];
const ALL_COLUMNS = [...LEFT_COLUMNS, ...RIGHT_COLUMNS];
const SHELF_ANCHORS_Y = [44.2, 69.2, 94.0];
const SLOT_BOX = { width: 10.4, height: 18 };
const EMPTY_RACK = Array.from({ length: 3 }, () => Array(MAX_CABINETS * SLOTS_PER_CABINET).fill(null));

function cloneEmptyRack() {
  return EMPTY_RACK.map((row) => [...row]);
}

function buildAnchorPoints(columns, shelfYs) {
  return shelfYs.map((y) => columns.map((x) => ({ x, y })));
}

const ANCHORS = buildAnchorPoints(ALL_COLUMNS, SHELF_ANCHORS_Y);

function createGKItem(image, name = "", studio = "", bgRemoved = false) {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    cloudId: null,
    userId: null,
    name,
    studio,
    image,
    extraImages: [],
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isSaved: false,
    bgRemoved,
    isAdult: false,
  };
}

function dbToItem(row) {
  return {
    id: row.id,
    cloudId: row.id,
    userId: row.user_id,
    name: row.name || "未命名GK",
    studio: row.studio || "未填寫工作室",
    image: row.image || "",
    extraImages: Array.isArray(row.extra_images) ? row.extra_images : [],
    scale: Number(row.scale ?? 1),
    offsetX: Number(row.offset_x ?? 0),
    offsetY: Number(row.offset_y ?? 0),
    isSaved: Boolean(row.is_saved),
    bgRemoved: Boolean(row.bg_removed),
    isAdult: Boolean(row.is_adult),
    shelfIndex: row.shelf_index,
    slotIndex: row.slot_index,
  };
}

function itemToDb(item, userId, shelfIndex, slotIndex) {
  return {
    user_id: userId,
    shelf_index: shelfIndex,
    slot_index: slotIndex,
    name: item.name || "未命名GK",
    studio: item.studio || "未填寫工作室",
    image: item.image || "",
    extra_images: item.extraImages || [],
    scale: item.scale ?? 1,
    offset_x: item.offsetX ?? 0,
    offset_y: item.offsetY ?? 0,
    is_saved: item.isSaved ?? false,
    bg_removed: item.bgRemoved ?? false,
    is_adult: item.isAdult ?? false,
    updated_at: new Date().toISOString(),
  };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dataUrlMime(dataUrl) {
  return String(dataUrl || "").match(/^data:(.*?);/)?.[1] || "image/png";
}

function mimeToExt(mime) {
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  return "png";
}

async function resizeDataUrlToWebp(dataUrl, maxSize = 1600, quality = 0.78) {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: true });
  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/webp", quality);
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mime = dataUrlMime(dataUrl);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function safeFileName(name) {
  const clean = String(name || "gk-image")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 48);
  return clean || "gk-image";
}

async function uploadImageToStorage({ file, dataUrl, userId, folder = "main" }) {
  if (!userId) throw new Error("缺少使用者 ID");

  const isDataUrl = typeof dataUrl === "string" && dataUrl.startsWith("data:");
  const blob = isDataUrl ? dataUrlToBlob(dataUrl) : file;
  const ext = isDataUrl ? mimeToExt(dataUrlMime(dataUrl)) : (file?.name?.split(".").pop() || "png").toLowerCase();
  const name = safeFileName(file?.name);
  const path = `${userId}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}.${ext}`;

  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, blob, {
    cacheControl: "3600",
    upsert: false,
    contentType: blob?.type || "image/png",
  });

  if (error) throw error;

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.crossOrigin = "anonymous";
    img.src = src;
  });
}

async function simpleRemoveBg(dataUrl, tolerance = 78) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const width = canvas.width;
  const height = canvas.height;
  const getPixel = (x, y) => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const corners = [getPixel(0, 0), getPixel(width - 1, 0), getPixel(0, height - 1), getPixel(width - 1, height - 1)];
  const bg = corners.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]).map((v) => v / corners.length);

  for (let i = 0; i < data.length; i += 4) {
    const diff = Math.sqrt(Math.pow(data[i] - bg[0], 2) + Math.pow(data[i + 1] - bg[1], 2) + Math.pow(data[i + 2] - bg[2], 2));
    if (diff < tolerance) data[i + 3] = 0;
    else if (diff < tolerance + 28) data[i + 3] = Math.max(0, Math.min(255, (diff - tolerance) * 8));
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function trimTransparentPng(dataUrl, padding = 18) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const width = canvas.width;
  const height = canvas.height;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 12) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return dataUrl;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const out = document.createElement("canvas");
  const outCtx = out.getContext("2d");
  out.width = cropWidth;
  out.height = cropHeight;
  outCtx.drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return out.toDataURL("image/png");
}

function SlotBase({ onClick, locked = false }) {
  return <button onClick={locked ? undefined : onClick} style={slotStyle(locked)} />;
}

function GKStand({ item, highlighted, onSelect, readOnly = false }) {
  const [tilt, setTilt] = useState({ rx: 0, ry: 0 });
  const [isHover, setIsHover] = useState(false);
  const scale = item.scale ?? 1;
  const offsetX = item.offsetX ?? 0;
  const offsetY = item.offsetY ?? 0;
  const isAdultDisplay = Boolean(item.isAdult);

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    setTilt({ rx: (0.5 - py) * 10, ry: (px - 0.5) * 14 });
  }

  function handleSelect() {
    if (isAdultDisplay && sessionStorage.getItem("gk_adult_session_ok") !== "yes") {
      const ok = window.confirm("此 GK 標示為 18+ 成人向內容。\n\n請確認你已滿 18 歲，並願意自行判斷瀏覽內容。");
      if (!ok) return;
      sessionStorage.setItem("gk_adult_session_ok", "yes");
    }
    onSelect?.();
  }

  return (
    <div
      onClick={handleSelect}
      onMouseMove={(e) => { setIsHover(true); handleMove(e); }}
      onMouseEnter={() => setIsHover(true)}
      onMouseLeave={() => { setIsHover(false); setTilt({ rx: 0, ry: 0 }); }}
      style={{ position: "relative", width: "100%", height: "100%", overflow: "visible", cursor: "pointer", perspective: "1000px", transformStyle: "preserve-3d", isolation: "isolate" }}
    >
      <img
        src={item.image}
        loading="lazy"
        decoding="async"
        alt={item.name || "GK"}
        style={{
          position: "absolute",
          left: "50%",
          bottom: 6,
          transform: `translateX(calc(-50% + ${offsetX}px)) translateY(${highlighted ? -4 + offsetY : offsetY}px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) scale(${highlighted ? scale * 1.03 : scale})`,
          width: "84%",
          height: "125%",
          objectFit: "contain",
          zIndex: 3,
          transition: "transform 120ms ease, filter 140ms ease",
          transformOrigin: "bottom center",
          pointerEvents: "none",
          filter: isHover
            ? "drop-shadow(0 0 16px rgba(96,165,250,0.95)) drop-shadow(0 0 34px rgba(168,85,247,0.42)) drop-shadow(0 12px 18px rgba(0,0,0,0.35))"
            : "drop-shadow(0 12px 18px rgba(0,0,0,0.35))",
          opacity: 1,
        }}
      />
      {isAdultDisplay && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 999,
            minWidth: 74,
            height: 44,
            padding: "0 16px",
            borderRadius: 999,
            background: "rgba(0,0,0,0.84)",
            color: "white",
            fontSize: 22,
            fontWeight: 950,
            letterSpacing: 0.4,
            boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 12px 28px rgba(0,0,0,0.68)",
            pointerEvents: "none",
            lineHeight: "44px",
            textAlign: "center",
            whiteSpace: "nowrap",
          }}
        >18+</div>
      )}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, type = "text" }) {
  return <input type={type} value={value} onChange={onChange} placeholder={placeholder} style={textInputStyle()} />;
}

function RangeControl({ label, value, min, max, step, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label style={{ fontSize: 12, color: "#cbd5e1" }}>{label}：{typeof value === "number" ? value.toFixed(step < 1 ? 2 : 0) : value}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function AuthScreen({ email, password, loading, setEmail, setPassword, signIn, signUp }) {
  return (
    <div style={{ minHeight: "100vh", background: "radial-gradient(circle at top, #1e1b4b, #05070b 48%, #020307)", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontFamily: "Arial, sans-serif", padding: 24 }}>
      <div style={{ width: "min(420px, 92vw)", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(8,11,16,0.86)", borderRadius: 26, padding: 28, boxShadow: "0 30px 100px rgba(0,0,0,0.55)", backdropFilter: "blur(18px)" }}>
        <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: 0.6, marginBottom: 8 }}>GK ROOM</div>
        <div style={{ color: "#a5b4fc", fontSize: 14, marginBottom: 24 }}>登入你的電子 GK 展示櫃</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <TextInput value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
          <button onClick={signIn} disabled={loading} style={{ ...primaryButton(), height: 46 }}>{loading ? "處理中..." : "登入"}</button>
          <button onClick={signUp} disabled={loading} style={secondaryButton()}>註冊新帳號</button>
        </div>
        <div style={{ color: "#6b7280", fontSize: 12, lineHeight: 1.6, marginTop: 18 }}>註冊後若 Supabase 有開 Email Confirm，可能要先去信箱確認。</div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("mine");
  const [roomSettings, setRoomSettings] = useState({
    id: null,
    public_left: true,
    public_right: true,
    public_third: false,
    public_cabinets: defaultPublicCabinets(),
    cabinet_count: MIN_CABINETS,
  });
  const [cabinetCount, setCabinetCount] = useState(() => Math.min(MAX_CABINETS, Math.max(MIN_CABINETS, Number(localStorage.getItem("gk_cabinet_count") || MIN_CABINETS))));
  const [profileName, setProfileName] = useState("GK玩家");
  const [publicRooms, setPublicRooms] = useState([]);
  const [viewingRoom, setViewingRoom] = useState(null);
  const [publicRack, setPublicRack] = useState(cloneEmptyRack);
  const [publicSelected, setPublicSelected] = useState(null);
  const [publicLoading, setPublicLoading] = useState(false);
  const [rack, setRack] = useState(cloneEmptyRack);
  const [selected, setSelected] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [previewImages, setPreviewImages] = useState([]);
  const [previewIndex, setPreviewIndex] = useState(null);
  const [useFreeRemoveBg, setUseFreeRemoveBg] = useState(() => localStorage.getItem("useFreeRemoveBg") !== "false");
  const [bgTolerance, setBgTolerance] = useState(() => Number(localStorage.getItem("bgTolerance") || 78));
  const [processing, setProcessing] = useState(false);
  const [processMessage, setProcessMessage] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const [favorites, setFavorites] = useState([]);
  const [favoriteIds, setFavoriteIds] = useState(new Set());
  const [favoriteCounts, setFavoriteCounts] = useState({});
  const [topFavoriteItems, setTopFavoriteItems] = useState([]);
  const [latestFavoriteItems, setLatestFavoriteItems] = useState([]);
  const [rankingSelected, setRankingSelected] = useState(null);
  const [likedIds, setLikedIds] = useState(new Set());
  const [likeCounts, setLikeCounts] = useState({});
  const [commentCounts, setCommentCounts] = useState({});
  const [comments, setComments] = useState([]);
  const [commentInput, setCommentInput] = useState("");
  const [ageAccepted, setAgeAccepted] = useState(() => localStorage.getItem("gk_age_ok") === "yes");
  const [sponsorAdOpen, setSponsorAdOpen] = useState(() => sessionStorage.getItem("gk_sponsor_ad_seen") !== "yes");
  const [sponsorAdCountdown, setSponsorAdCountdown] = useState(5);
  const [isMobile, setIsMobile] = useState(() => isMobileDevice());
  const [isCompactDesktop, setIsCompactDesktop] = useState(() => !isMobileDevice() && window.innerWidth <= 1250);
  const fileInputRef = useRef(null);
  const uploadTargetRef = useRef(null);
  const extraInputRef = useRef(null);

  useEffect(() => {
    const handleResize = () => {
      const mobile = isMobileDevice();
      setIsMobile(mobile);
      setIsCompactDesktop(!mobile && window.innerWidth <= 1250);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!user || !sponsorAdOpen) return;
    setSponsorAdCountdown(5);
    const timer = setInterval(() => {
      setSponsorAdCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [user, sponsorAdOpen]);

  function closeSponsorAd() {
    if (sponsorAdCountdown > 0) return;
    sessionStorage.setItem("gk_sponsor_ad_seen", "yes");
    setSponsorAdOpen(false);
  }

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      setUser(data.user ?? null);
      setAuthLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (user) {
      loadCloudRack(user.id);
      loadFavoriteIds(user.id);
      loadLikeIds(user.id);
      loadSocialStats();
    } else {
      setRack(cloneEmptyRack());
      setSelected(null);
      setFavorites([]);
      setFavoriteIds(new Set());
    }
  }, [user]);

  useEffect(() => {
    localStorage.setItem("gk_cabinet_count", String(cabinetCount));
  }, [cabinetCount]);

  useEffect(() => {
    if (!user) return;
    try {
      localStorage.setItem(`${STORAGE_KEY}-${user.id}`, JSON.stringify(rack));
    } catch (error) {
      console.error("localStorage save failed", error);
    }
  }, [rack, user]);

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

    if (error) {
      alert(error.message);
      return;
    }

    const createdUser = data?.user;
    if (createdUser) {
      const defaultName = email.split("@")[0] || "GK玩家";
      await supabase.from("profiles").upsert({ id: createdUser.id, username: defaultName });
      await supabase.from("gk_rooms").upsert({
        user_id: createdUser.id,
        room_name: `${defaultName} 的 GK ROOM`,
        is_public: true,
        public_left: true,
        public_right: true,
        public_third: false,
        public_cabinets: defaultPublicCabinets(),
        cabinet_count: MIN_CABINETS,
      }, { onConflict: "user_id" });
    }

    alert("註冊成功。若系統要求信箱驗證，請先到信箱確認。");
  }

  async function logout() {
    await supabase.auth.signOut();
  }

  async function ensureProfile(userId) {
    if (!userId) return;
    const { data, error } = await supabase.from("profiles").select("id, username").eq("id", userId).maybeSingle();
    if (error) {
      console.error(error);
      return;
    }
    if (!data) {
      await supabase.from("profiles").insert({ id: userId, username: user?.email?.split("@")[0] || "GK玩家" });
    }
  }

  async function loadProfile(userId) {
    if (!userId) return;
    const { data, error } = await supabase.from("profiles").select("username").eq("id", userId).maybeSingle();
    if (error) {
      console.error(error);
      return;
    }
    if (data?.username) setProfileName(data.username);
  }

  async function saveProfileName() {
    if (!user) return;
    const cleanName = (profileName || "").trim() || "GK玩家";

    const { error: profileError } = await supabase.from("profiles").upsert({ id: user.id, username: cleanName });
    if (profileError) {
      console.error(profileError);
      alert("名稱儲存失敗");
      return;
    }

    const { error: roomError } = await supabase.from("gk_rooms").update({ room_name: `${cleanName} 的 GK ROOM`, updated_at: new Date().toISOString() }).eq("user_id", user.id);
    if (roomError) {
      console.error(roomError);
      alert("展示櫃名稱儲存失敗");
      return;
    }

    setProfileName(cleanName);
    setSyncMessage("名稱已儲存");
    if (mode === "explore") loadPublicRooms();
    alert("名稱已儲存");
  }

  async function ensureRoom(userId) {
    const { data: existing, error } = await supabase.from("gk_rooms").select("id, public_left, public_right, public_third, public_cabinets, cabinet_count, room_name").eq("user_id", userId).maybeSingle();
    if (error) {
      console.error(error);
      return null;
    }
    if (existing) {
      const publicCabinets = normalizePublicCabinets(existing.public_cabinets || [existing.public_left ?? true, existing.public_right ?? true, existing.public_third ?? false]);
      const nextCount = Math.min(MAX_CABINETS, Math.max(MIN_CABINETS, Number(existing.cabinet_count || MIN_CABINETS)));
      setCabinetCount(nextCount);
      setRoomSettings({
        id: existing.id,
        public_left: publicCabinets[0],
        public_right: publicCabinets[1],
        public_third: publicCabinets[2],
        public_cabinets: publicCabinets,
        cabinet_count: nextCount,
      });
      return { ...existing, public_cabinets: publicCabinets, cabinet_count: nextCount };
    }

    const defaultName = profileName || user?.email?.split("@")[0] || "GK玩家";
    const initialPublicCabinets = defaultPublicCabinets();
    const { data: created, error: createError } = await supabase.from("gk_rooms").insert({
      user_id: userId,
      room_name: `${defaultName} 的 GK ROOM`,
      is_public: true,
      public_left: initialPublicCabinets[0],
      public_right: initialPublicCabinets[1],
      public_third: initialPublicCabinets[2],
      public_cabinets: initialPublicCabinets,
      cabinet_count: MIN_CABINETS,
    }).select("id, public_left, public_right, public_third, public_cabinets, cabinet_count, room_name").single();
    if (createError) {
      console.error(createError);
      return null;
    }
    setRoomSettings({ id: created.id, public_left: initialPublicCabinets[0], public_right: initialPublicCabinets[1], public_third: initialPublicCabinets[2], public_cabinets: initialPublicCabinets, cabinet_count: MIN_CABINETS });
    return created;
  }

  async function loadCloudRack(userId) {
    setSyncMessage("正在載入雲端展示櫃...");
    await ensureProfile(userId);
    await loadProfile(userId);
    await ensureRoom(userId);

    const { data, error } = await supabase.from("gk_items").select("*").eq("user_id", userId).order("shelf_index", { ascending: true }).order("slot_index", { ascending: true });
    if (error) {
      console.error(error);
      setSyncMessage("雲端載入失敗，先使用本機暫存");
      try {
        const saved = localStorage.getItem(`${STORAGE_KEY}-${userId}`);
        setRack(saved ? JSON.parse(saved) : cloneEmptyRack());
      } catch {
        setRack(cloneEmptyRack());
      }
      return;
    }

    setRack(rowsToRack(data || []));
    setSelected(null);
    setSyncMessage("雲端已同步");
  }

  function rowsToRack(rows) {
    const next = cloneEmptyRack();
    rows.forEach((row) => {
      if (row.shelf_index >= 0 && row.shelf_index < 3 && row.slot_index >= 0 && row.slot_index < MAX_CABINETS * SLOTS_PER_CABINET) {
        next[row.shelf_index][row.slot_index] = dbToItem(row);
      }
    });
    return next;
  }

  async function updateCabinetPrivacy(side, value) {
    if (!user) return;
    const cabinetIndex = typeof side === "number" ? side : side === "left" ? 0 : side === "right" ? 1 : 2;
    const publicCabinets = normalizePublicCabinets(roomSettings.public_cabinets);
    publicCabinets[cabinetIndex] = value;
    const next = {
      ...roomSettings,
      public_left: publicCabinets[0],
      public_right: publicCabinets[1],
      public_third: publicCabinets[2],
      public_cabinets: publicCabinets,
    };
    setRoomSettings(next);

    const activePublicCabinets = publicCabinets.slice(0, cabinetCount);
    const { error } = await supabase.from("gk_rooms").update({
      public_left: publicCabinets[0],
      public_right: publicCabinets[1],
      public_third: publicCabinets[2],
      public_cabinets: publicCabinets,
      is_public: activePublicCabinets.some(Boolean),
      updated_at: new Date().toISOString(),
    }).eq("user_id", user.id);
    if (error) {
      console.error(error);
      setSyncMessage("公開設定儲存失敗");
    } else {
      setSyncMessage("公開設定已儲存");
    }
  }

  async function changeCabinetCount(nextCount) {
    if (!user) return;
    const safeCount = Math.min(MAX_CABINETS, Math.max(MIN_CABINETS, nextCount));
    setCabinetCount(safeCount);
    localStorage.setItem("gk_cabinet_count", String(safeCount));
    const publicCabinets = normalizePublicCabinets(roomSettings.public_cabinets);
    const next = { ...roomSettings, cabinet_count: safeCount, public_cabinets: publicCabinets };
    setRoomSettings(next);
    const { error } = await supabase.from("gk_rooms").update({
      cabinet_count: safeCount,
      public_cabinets: publicCabinets,
      public_left: publicCabinets[0],
      public_right: publicCabinets[1],
      public_third: publicCabinets[2],
      is_public: publicCabinets.slice(0, safeCount).some(Boolean),
      updated_at: new Date().toISOString(),
    }).eq("user_id", user.id);
    if (error) {
      console.error(error);
      setSyncMessage("櫃數儲存失敗");
    } else {
      setSyncMessage("櫃數已儲存");
    }
  }

  async function loadPublicRooms() {
    setMode("explore");
    await loadSocialStats();
    setViewingRoom(null);
    setPublicSelected(null);
    setPublicLoading(true);

    const { data: roomRows, error } = await supabase
      .from("gk_rooms")
      .select("id,user_id,room_name,is_public,public_left,public_right,public_third,public_cabinets,cabinet_count,updated_at,created_at")
      .eq("is_public", true)
      .order("updated_at", { ascending: false });

    if (error) {
      console.error(error);
      setPublicRooms([]);
      setPublicLoading(false);
      return;
    }

    const visibleRooms = [];
    const seen = new Set();
    for (const room of roomRows || []) {
      if (seen.has(room.user_id)) continue;
      const publicCabinets = normalizePublicCabinets(room.public_cabinets || [room.public_left, room.public_right, room.public_third]);
      const count = Math.min(MAX_CABINETS, Math.max(MIN_CABINETS, Number(room.cabinet_count || MIN_CABINETS)));
      if (!publicCabinets.slice(0, count).some(Boolean)) continue;
      seen.add(room.user_id);
      visibleRooms.push(room);
    }

    const userIds = visibleRooms.map((room) => room.user_id);
    let profileMap = new Map();
    if (userIds.length) {
      const { data: profiles, error: profileError } = await supabase.from("profiles").select("id,username").in("id", userIds);
      if (profileError) console.error(profileError);
      profileMap = new Map((profiles || []).map((profile) => [profile.id, profile.username]));
    }

    let previewMap = new Map();
    if (userIds.length) {
      const { data: previewRows, error: previewError } = await supabase
        .from("gk_items")
        .select("user_id,image,is_adult,shelf_index,slot_index")
        .in("user_id", userIds)
        .eq("shelf_index", 0)
        .order("slot_index", { ascending: true });
      if (previewError) console.error(previewError);
      for (const row of previewRows || []) {
        const room = visibleRooms.find((r) => r.user_id === row.user_id);
        if (!room) continue;
        const publicCabinets = normalizePublicCabinets(room.public_cabinets || [room.public_left, room.public_right, room.public_third]);
        const count = Math.min(MAX_CABINETS, Math.max(MIN_CABINETS, Number(room.cabinet_count || MIN_CABINETS)));
        const cabinetIndex = cabinetIndexFromSlot(row.slot_index);
        if (cabinetIndex >= count || !publicCabinets[cabinetIndex]) continue;
        const list = previewMap.get(row.user_id) || [];
        if (list.length < 3) {
          list.push({ image: row.image, isAdult: Boolean(row.is_adult) });
          previewMap.set(row.user_id, list);
        }
      }
    }

    setPublicRooms(visibleRooms.map((room) => ({
      ...room,
      public_cabinets: normalizePublicCabinets(room.public_cabinets || [room.public_left, room.public_right, room.public_third]),
      cabinet_count: Math.min(MAX_CABINETS, Math.max(MIN_CABINETS, Number(room.cabinet_count || MIN_CABINETS))),
      previewImages: previewMap.get(room.user_id) || [],
      profiles: { username: profileMap.get(room.user_id) || "GK玩家" },
    })));
    setPublicLoading(false);
  }

  async function openPublicRoom(room) {
    setViewingRoom({
      ...room,
      public_cabinets: normalizePublicCabinets(room.public_cabinets || [room.public_left, room.public_right, room.public_third]),
      cabinet_count: Math.min(MAX_CABINETS, Math.max(MIN_CABINETS, Number(room.cabinet_count || MIN_CABINETS))),
    });
    setPublicSelected(null);
    setPublicLoading(true);

    const { data, error } = await supabase.from("gk_items").select("*").eq("user_id", room.user_id).order("shelf_index", { ascending: true }).order("slot_index", { ascending: true });
    if (error) console.error(error);

    const publicCabinets = normalizePublicCabinets(room.public_cabinets || [room.public_left, room.public_right, room.public_third]);
    const count = Math.min(MAX_CABINETS, Math.max(MIN_CABINETS, Number(room.cabinet_count || MIN_CABINETS)));
    const visibleRows = (data || []).filter((row) => {
      const cabinetIndex = cabinetIndexFromSlot(row.slot_index);
      return cabinetIndex < count && publicCabinets[cabinetIndex];
    });

    setPublicRack(rowsToRack(visibleRows));
    setMode("publicRoom");
    setPublicLoading(false);
  }

  async function upsertCloudItem(item, shelfIndex, slotIndex) {
    if (!user || !item) return item;
    const payload = itemToDb(item, user.id, shelfIndex, slotIndex);
    if (item.cloudId) {
      const { error } = await supabase.from("gk_items").update(payload).eq("id", item.cloudId).eq("user_id", user.id);
      if (error) {
        console.error(error);
        setSyncMessage("雲端更新失敗");
        return item;
      }
      setSyncMessage("雲端已儲存");
      return item;
    }

    const { data, error } = await supabase.from("gk_items").insert(payload).select("id").single();
    if (error) {
      console.error(error);
      setSyncMessage("雲端新增失敗");
      return item;
    }
    setSyncMessage("雲端已儲存");
    return { ...item, id: data.id, cloudId: data.id, userId: user.id };
  }

  async function deleteSelectedItem() {
    if (!user || !selected) return;
    if (!window.confirm(`確定要刪除「${selected.name || "這隻GK"}」嗎？賣掉或不收藏了就可以刪除。`)) return;

    if (selected.cloudId) {
      const { error } = await supabase.from("gk_items").delete().eq("id", selected.cloudId).eq("user_id", user.id);
      if (error) {
        console.error(error);
        alert("刪除失敗");
        return;
      }
    }

    setRack((prev) => prev.map((row, shelfIndex) => row.map((item, slotIndex) => (shelfIndex === selected.shelfIndex && slotIndex === selected.slotIndex ? null : item))));
    setSelected(null);
    setIsEditingMeta(false);
    setSyncMessage("GK 已刪除");
  }

  async function loadFavoriteIds(userId = user?.id) {
    if (!userId) return;
    const { data, error } = await supabase.from("gk_favorites").select("item_id").eq("user_id", userId);
    if (error) {
      console.error(error);
      return;
    }
    setFavoriteIds(new Set((data || []).map((row) => row.item_id)));
  }

  async function loadSocialStats() {
    const { data: favRows, error: favError } = await supabase
      .from("gk_favorites")
      .select("item_id,owner_id,created_at")
      .order("created_at", { ascending: false })
      .limit(500);

    if (favError) console.error(favError);

    const favoriteCountMap = {};
    for (const fav of favRows || []) favoriteCountMap[fav.item_id] = (favoriteCountMap[fav.item_id] || 0) + 1;
    setFavoriteCounts(favoriteCountMap);

    const { data: likeRows, error: likeError } = await supabase
      .from("gk_likes")
      .select("item_id")
      .limit(1000);

    if (likeError) console.error(likeError);

    const likeCountMap = {};
    for (const like of likeRows || []) likeCountMap[like.item_id] = (likeCountMap[like.item_id] || 0) + 1;
    setLikeCounts(likeCountMap);

    const { data: commentRows, error: commentError } = await supabase
      .from("gk_comments")
      .select("item_id")
      .limit(1000);

    if (commentError) console.error(commentError);

    const commentCountMap = {};
    for (const comment of commentRows || []) commentCountMap[comment.item_id] = (commentCountMap[comment.item_id] || 0) + 1;
    setCommentCounts(commentCountMap);

    const topIds = Object.keys(favoriteCountMap)
      .sort((a, b) => (favoriteCountMap[b] || 0) - (favoriteCountMap[a] || 0))
      .slice(0, 12);

    const { data: latestRows, error: latestError } = await supabase
      .from("gk_items")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(12);

    if (latestError) console.error(latestError);

    const latestItemRows = latestRows || [];
    const latestIds = latestItemRows.map((item) => item.id);
    const itemIds = [...new Set([...topIds, ...latestIds])];
    const ownerIds = [...new Set([...(favRows || []).map((fav) => fav.owner_id), ...latestItemRows.map((item) => item.user_id)])];

    if (!itemIds.length) {
      setTopFavoriteItems([]);
      setLatestFavoriteItems([]);
      return;
    }

    const [{ data: topItemRows }, { data: profileRows }, { data: roomRows }] = await Promise.all([
      topIds.length ? supabase.from("gk_items").select("*").in("id", topIds) : Promise.resolve({ data: [] }),
      ownerIds.length ? supabase.from("profiles").select("id,username").in("id", ownerIds) : Promise.resolve({ data: [] }),
      ownerIds.length ? supabase.from("gk_rooms").select("user_id,room_name").in("user_id", ownerIds) : Promise.resolve({ data: [] }),
    ]);

    const itemMap = new Map([...(topItemRows || []), ...latestItemRows].map((item) => [item.id, item]));
    const profileMap = new Map((profileRows || []).map((profile) => [profile.id, profile.username]));
    const roomMap = new Map((roomRows || []).map((room) => [room.user_id, room.room_name]));

    function enrich(itemId) {
      const row = itemMap.get(itemId);
      if (!row) return null;
      return {
        item: dbToItem(row),
        count: favoriteCountMap[itemId] || 0,
        likeCount: likeCountMap[itemId] || 0,
        commentCount: commentCountMap[itemId] || 0,
        ownerName: profileMap.get(row.user_id) || "GK玩家",
        roomName: roomMap.get(row.user_id) || "公開展示櫃",
        location: cabinetLocation(row.shelf_index, row.slot_index),
        createdAt: row.created_at,
      };
    }

    setTopFavoriteItems(topIds.map(enrich).filter(Boolean));
    setLatestFavoriteItems(latestIds.map(enrich).filter(Boolean));
  }

  async function loadLikeIds(userId = user?.id) {
    if (!userId) return;
    const { data, error } = await supabase.from("gk_likes").select("item_id").eq("user_id", userId);
    if (error) {
      console.error(error);
      return;
    }
    setLikedIds(new Set((data || []).map((row) => row.item_id)));
  }

  async function loadComments(itemId) {
    if (!itemId) {
      setComments([]);
      return;
    }

    const { data, error } = await supabase
      .from("gk_comments")
      .select("id,item_id,user_id,body,created_at,profiles(username)")
      .eq("item_id", itemId)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) {
      console.error(error);
      setComments([]);
      return;
    }

    setComments(data || []);
  }

  async function toggleLike(item) {
    if (!user || !item?.cloudId) return;

    const isLiked = likedIds.has(item.cloudId);
    if (isLiked) {
      const { error } = await supabase.from("gk_likes").delete().eq("user_id", user.id).eq("item_id", item.cloudId);
      if (error) {
        console.error(error);
        alert("取消讚失敗");
        return;
      }
      const next = new Set(likedIds);
      next.delete(item.cloudId);
      setLikedIds(next);
      setLikeCounts((prev) => ({ ...prev, [item.cloudId]: Math.max(0, (prev[item.cloudId] || 0) - 1) }));
      return;
    }

    const { error } = await supabase.from("gk_likes").insert({
      user_id: user.id,
      item_id: item.cloudId,
      owner_id: item.userId,
    });

    if (error) {
      console.error(error);
      alert("按讚失敗，可能已經按過讚");
      return;
    }

    const next = new Set(likedIds);
    next.add(item.cloudId);
    setLikedIds(next);
    setLikeCounts((prev) => ({ ...prev, [item.cloudId]: (prev[item.cloudId] || 0) + 1 }));
  }

  async function addComment(item) {
    if (!user || !item?.cloudId) return;
    const body = commentInput.trim();
    if (!body) return;

    const { error } = await supabase.from("gk_comments").insert({
      user_id: user.id,
      item_id: item.cloudId,
      owner_id: item.userId,
      body,
    });

    if (error) {
      console.error(error);
      alert("留言失敗");
      return;
    }

    setCommentInput("");
    setCommentCounts((prev) => ({ ...prev, [item.cloudId]: (prev[item.cloudId] || 0) + 1 }));
    await loadComments(item.cloudId);
  }

  async function loadFavorites() {
    if (!user) return;
    setMode("favorites");
    setSelected(null);
    setPublicSelected(null);

    const { data: favRows, error } = await supabase.from("gk_favorites").select("id,item_id,owner_id,created_at").eq("user_id", user.id).order("created_at", { ascending: false });
    if (error) {
      console.error(error);
      alert("收藏載入失敗");
      return;
    }

    const itemIds = (favRows || []).map((row) => row.item_id);
    const ownerIds = [...new Set((favRows || []).map((row) => row.owner_id))];
    if (!itemIds.length) {
      setFavorites([]);
      return;
    }

    const [{ data: itemRows }, { data: profileRows }, { data: roomRows }] = await Promise.all([
      supabase.from("gk_items").select("*").in("id", itemIds),
      supabase.from("profiles").select("id,username").in("id", ownerIds),
      supabase.from("gk_rooms").select("user_id,room_name").in("user_id", ownerIds),
    ]);

    const itemMap = new Map((itemRows || []).map((item) => [item.id, item]));
    const profileMap = new Map((profileRows || []).map((profile) => [profile.id, profile.username]));
    const roomMap = new Map((roomRows || []).map((room) => [room.user_id, room.room_name]));

    const merged = (favRows || [])
      .map((fav) => {
        const item = itemMap.get(fav.item_id);
        if (!item) return null;
        return {
          favoriteId: fav.id,
          item: dbToItem(item),
          ownerId: fav.owner_id,
          ownerName: profileMap.get(fav.owner_id) || "GK玩家",
          roomName: roomMap.get(fav.owner_id) || "公開展示櫃",
          location: cabinetLocation(item.shelf_index, item.slot_index),
          createdAt: fav.created_at,
        };
      })
      .filter(Boolean);

    setFavorites(merged);
    await loadFavoriteIds(user.id);
  }

  async function toggleFavorite(item) {
    if (!user || !item?.cloudId || !item?.userId) return;
    if (item.userId === user.id) {
      alert("自己的 GK 不需要收藏，可以在我的展示間管理。");
      return;
    }

    const isFav = favoriteIds.has(item.cloudId);
    if (isFav) {
      const { error } = await supabase.from("gk_favorites").delete().eq("user_id", user.id).eq("item_id", item.cloudId);
      if (error) {
        console.error(error);
        alert("取消收藏失敗");
        return;
      }
      const next = new Set(favoriteIds);
      next.delete(item.cloudId);
      setFavoriteIds(next);
      setFavorites((prev) => prev.filter((fav) => fav.item.cloudId !== item.cloudId));
    } else {
      const { error } = await supabase.from("gk_favorites").insert({ user_id: user.id, item_id: item.cloudId, owner_id: item.userId });
      if (error) {
        console.error(error);
        alert("收藏失敗，可能已收藏過或資料表權限未設定");
        return;
      }
      const next = new Set(favoriteIds);
      next.add(item.cloudId);
      setFavoriteIds(next);
      alert("已加入收藏管理");
    }
  }

  function toggleFreeRemoveBg(value) {
    setUseFreeRemoveBg(value);
    localStorage.setItem("useFreeRemoveBg", value ? "true" : "false");
  }

  function updateTolerance(value) {
    setBgTolerance(value);
    localStorage.setItem("bgTolerance", String(value));
  }

  function openUpload(shelfIndex, slotIndex) {
    uploadTargetRef.current = { shelfIndex, slotIndex };
    fileInputRef.current?.click();
  }

  async function prepareImage(file) {
    setProcessMessage("正在載入圖片...");
    let dataUrl = await fileToDataUrl(file);
    let bgRemoved = false;
    if (useFreeRemoveBg) {
      setProcessMessage("正在免費去背...");
      try {
        dataUrl = await simpleRemoveBg(dataUrl, bgTolerance);
        bgRemoved = true;
      } catch (error) {
        console.error(error);
      }
    }
    setProcessMessage("正在自動裁切...");
    try {
      dataUrl = await trimTransparentPng(dataUrl, 18);
    } catch (error) {
      console.error(error);
    }
    setProcessMessage("正在壓縮圖片節省流量...");
    try {
      dataUrl = await resizeDataUrlToWebp(dataUrl, 1600, 0.78);
    } catch (error) {
      console.error(error);
    }
    return { dataUrl, bgRemoved };
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    const target = uploadTargetRef.current;
    if (!file || !target || !user) return;
    setProcessing(true);
    setProcessMessage("準備處理圖片...");
    try {
      const { dataUrl, bgRemoved } = await prepareImage(file);
      setProcessMessage("正在上傳到雲端圖片空間...");
      const imageUrl = await uploadImageToStorage({ file, dataUrl, userId: user.id, folder: "main" });
      const newItem = createGKItem(imageUrl, file.name.replace(/\.[^.]+$/, "") || "", "", bgRemoved);
      const next = rack.map((row) => [...row]);
      next[target.shelfIndex][target.slotIndex] = newItem;
      setRack(next);
      setSelected({ ...newItem, location: cabinetLocation(target.shelfIndex, target.slotIndex), shelfIndex: target.shelfIndex, slotIndex: target.slotIndex });
      setIsEditingMeta(true);
      setProcessMessage("圖片已上傳，請填資料後按儲存");
    } catch (error) {
      console.error(error);
      alert(`上傳失敗：${error.message || "請檢查 Storage Policy"}`);
      setProcessMessage("上傳失敗");
    } finally {
      setProcessing(false);
      event.target.value = "";
    }
  }

  function cabinetLocation(shelfIndex, slotIndex) {
    const cabinetIndex = cabinetIndexFromSlot(slotIndex);
    return `${cabinetTitle(cabinetIndex)} / 第 ${shelfIndex + 1} 層 / 第 ${(slotIndex % SLOTS_PER_CABINET) + 1} 格`;
  }

  function selectItem(item, shelfIndex, slotIndex) {
    setSelected({ ...item, location: cabinetLocation(shelfIndex, slotIndex), shelfIndex, slotIndex });
    loadComments(item.cloudId);
    setIsEditingMeta(!item.isSaved);
    setHighlight(item.id);
    setTimeout(() => setHighlight(null), 1600);
  }

  function selectPublicItem(item, shelfIndex, slotIndex) {
    setPublicSelected({ ...item, location: cabinetLocation(shelfIndex, slotIndex), shelfIndex, slotIndex });
    loadComments(item.cloudId);
    setHighlight(item.id);
    setTimeout(() => setHighlight(null), 1600);
  }

  function patchItemById(itemId, patch) {
    setRack((prev) => prev.map((row) => row.map((item) => (item && item.id === itemId ? { ...item, ...patch } : item))));
  }

  function updateSelectedField(field, value) {
    if (!selected) return;
    setSelected((prev) => ({ ...prev, [field]: value }));
    patchItemById(selected.id, { [field]: value });
  }

  async function saveAllSettings() {
    if (!selected || !user) return;
    const patch = {
      name: (selected.name || "").trim() || "未命名GK",
      studio: (selected.studio || "").trim() || "未填寫工作室",
      scale: selected.scale ?? 1,
      offsetX: selected.offsetX ?? 0,
      offsetY: selected.offsetY ?? 0,
      extraImages: selected.extraImages || [],
      isAdult: selected.isAdult ?? false,
      isSaved: true,
    };
    const finalItem = { ...selected, ...patch };
    const savedItem = await upsertCloudItem(finalItem, selected.shelfIndex, selected.slotIndex);
    const finalSavedItem = { ...finalItem, id: savedItem.id, cloudId: savedItem.cloudId, userId: user.id };

    setSelected((prev) => ({ ...prev, ...finalSavedItem }));
    setRack((prev) => prev.map((row, shelfIndex) => row.map((item, slotIndex) => (shelfIndex === selected.shelfIndex && slotIndex === selected.slotIndex ? finalSavedItem : item))));
    setIsEditingMeta(false);
  }

  async function handleExtraUpload(event) {
    const files = Array.from(event.target.files || []).slice(0, 5);
    if (!selected || !files.length || !user) return;
    setProcessing(true);
    setProcessMessage("正在上傳細節圖片...");
    try {
      const current = selected.extraImages || [];
      const slotsLeft = Math.max(0, 5 - current.length);
      const images = [];
      for (const file of files.slice(0, slotsLeft)) {
        const rawDataUrl = await fileToDataUrl(file);
        const dataUrl = await resizeDataUrlToWebp(rawDataUrl, 1600, 0.78);
        const url = await uploadImageToStorage({ file, dataUrl, userId: user.id, folder: "details" });
        images.push(url);
      }
      updateSelectedField("extraImages", [...current, ...images].slice(0, 5));
      setProcessMessage("細節圖片已上傳，記得按儲存到雲端");
    } catch (error) {
      console.error(error);
      alert(`細節圖片上傳失敗：${error.message || "請檢查 Storage Policy"}`);
    } finally {
      setProcessing(false);
      event.target.value = "";
    }
  }

  function removeExtraImage(index) {
    if (!selected) return;
    updateSelectedField("extraImages", (selected.extraImages || []).filter((_, i) => i !== index));
  }

  function openImagePreview(images, index = 0) {
    const list = Array.isArray(images) ? images : [images];
    setPreviewImages(list);
    setPreviewIndex(index);
  }

  function closeImagePreview() {
    setPreviewImages([]);
    setPreviewIndex(null);
  }

  function showPrevImage() {
    setPreviewIndex((prev) => {
      if (prev === null || previewImages.length === 0) return prev;
      return (prev - 1 + previewImages.length) % previewImages.length;
    });
  }

  function showNextImage() {
    setPreviewIndex((prev) => {
      if (prev === null || previewImages.length === 0) return prev;
      return (prev + 1) % previewImages.length;
    });
  }

  async function resetAllData() {
    if (!user) return;
    if (!window.confirm("確定要清空目前雲端展示櫃資料嗎？")) return;
    await supabase.from("gk_items").delete().eq("user_id", user.id);
    setRack(cloneEmptyRack());
    setSelected(null);
    localStorage.removeItem(`${STORAGE_KEY}-${user.id}`);
    setSyncMessage("展示櫃已清空");
  }

  if (authLoading) return <div style={{ minHeight: "100vh", background: "#05070b", color: "white", display: "flex", alignItems: "center", justifyContent: "center" }}>GK ROOM 載入中...</div>;
  if (!user) return <AuthScreen email={email} password={password} loading={loginLoading} setEmail={setEmail} setPassword={setPassword} signIn={signIn} signUp={signUp} />;

  const activeRack = mode === "publicRoom" ? publicRack : rack;
  const isRankingMode = mode === "topFavorites" || mode === "latestFavorites";
  const activeSelected = isRankingMode ? rankingSelected : mode === "publicRoom" ? publicSelected : selected;
  const readOnly = mode === "publicRoom" || isRankingMode;

  if (isMobile) {
    return (
      <MobileLayout
        user={user}
        mode={mode}
        setMode={setMode}
        profileName={profileName}
        setProfileName={setProfileName}
        saveProfileName={saveProfileName}
        roomSettings={roomSettings}
        cabinetCount={cabinetCount}
        setCabinetCount={changeCabinetCount}
        updateCabinetPrivacy={updateCabinetPrivacy}
        useFreeRemoveBg={useFreeRemoveBg}
        toggleFreeRemoveBg={toggleFreeRemoveBg}
        bgTolerance={bgTolerance}
        updateTolerance={updateTolerance}
        processMessage={processMessage}
        syncMessage={syncMessage}
        processing={processing}
        loadCloudRack={() => loadCloudRack(user.id)}
        loadFavorites={loadFavorites}
        loadPublicRooms={loadPublicRooms}
        logout={logout}
        resetAllData={resetAllData}
        activeRack={activeRack}
        activeSelected={activeSelected}
        readOnly={readOnly}
        highlight={highlight}
        openUpload={openUpload}
        selectItem={readOnly ? selectPublicItem : selectItem}
        viewingRoom={viewingRoom}
        publicLoading={publicLoading}
        publicRooms={publicRooms}
        openPublicRoom={openPublicRoom}
        favorites={favorites}
        openImagePreview={openImagePreview}
        toggleFavorite={toggleFavorite}
        favoriteCounts={favoriteCounts}
        likedIds={likedIds}
        likeCounts={likeCounts}
        commentCounts={commentCounts}
        comments={comments}
        commentInput={commentInput}
        setCommentInput={setCommentInput}
        toggleLike={toggleLike}
        addComment={addComment}
        loadSocialStats={loadSocialStats}
        loadComments={loadComments}
        setRankingSelected={setRankingSelected}
        topFavoriteItems={topFavoriteItems}
        latestFavoriteItems={latestFavoriteItems}
        isFavorite={activeSelected?.cloudId ? favoriteIds.has(activeSelected.cloudId) : false}
        isEditingMeta={isEditingMeta}
        setIsEditingMeta={setIsEditingMeta}
        updateSelectedField={updateSelectedField}
        saveAllSettings={saveAllSettings}
        deleteSelectedItem={deleteSelectedItem}
        extraInputRef={extraInputRef}
        removeExtraImage={removeExtraImage}
        fileInputRef={fileInputRef}
        handleUpload={handleUpload}
        handleExtraUpload={handleExtraUpload}
        onCloseMobileDetail={() => {
          setSelected(null);
          setPublicSelected(null);
          setIsEditingMeta(false);
        }}
        previewIndex={previewIndex}
        previewImages={previewImages}
        closeImagePreview={closeImagePreview}
        showPrevImage={showPrevImage}
        showNextImage={showNextImage}
        sponsorAdOpen={sponsorAdOpen}
        sponsorAdCountdown={sponsorAdCountdown}
        closeSponsorAd={closeSponsorAd}
      />
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#07090d", color: "white", overflow: "hidden", fontFamily: "Arial, sans-serif" }}>
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUpload} style={{ display: "none" }} />
      <input ref={extraInputRef} type="file" accept="image/*" multiple onChange={handleExtraUpload} style={{ display: "none" }} />

      <aside style={leftAsideStyle()}>
        <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.15, marginBottom: 22, letterSpacing: 0.4 }}>GK<br />ROOM</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          <button onClick={() => { setMode("mine"); setViewingRoom(null); }} style={navButton(mode === "mine")}>我的展示間</button>
          <button onClick={loadFavorites} style={navButton(mode === "favorites")}>收藏管理</button>
          <button onClick={loadPublicRooms} style={navButton(mode === "explore" || mode === "publicRoom")}>公開展櫃</button>
          <button onClick={() => setMode("topFavorites")} style={navButton(mode === "topFavorites")}>排行榜</button>
          <button onClick={() => setMode("latestFavorites")} style={navButton(mode === "latestFavorites")}>最新上架</button>
        </div>

        {mode === "mine" && (
          <>
            <div style={{ ...panelBox(), marginTop: 12 }}>
              <div style={{ fontSize: 13, color: "#e5e7eb", marginBottom: 10, fontWeight: 800 }}>免費去背</div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 10, color: "#cbd5e1" }}>
                <input type="checkbox" checked={useFreeRemoveBg} onChange={(e) => toggleFreeRemoveBg(e.target.checked)} />上傳時自動去背
              </label>
              <RangeControl label="去背強度" value={bgTolerance} min={35} max={130} step={1} onChange={updateTolerance} />
              <div style={{ color: "#6b7280", fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>免費版適合白底、灰底、乾淨背景。</div>
              {processMessage && <div style={{ color: processing ? "#93c5fd" : "#9ca3af", fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>{processMessage}</div>}
              {syncMessage && <div style={{ color: "#86efac", fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>{syncMessage}</div>}
            </div>
            <SponsorCard />
          </>
        )}

        {mode === "mine" && <button onClick={() => loadCloudRack(user.id)} style={{ ...secondaryButton(), width: "100%", marginTop: 12 }}>重新同步雲端</button>}
        {mode === "mine" && <button onClick={resetAllData} style={{ ...dangerButton(), marginTop: 10 }}>清空雲端資料</button>}
        {mode === "publicRoom" && <button onClick={loadPublicRooms} style={{ ...secondaryButton(), width: "100%", marginTop: 12 }}>返回公開展櫃</button>}
        <button onClick={logout} style={{ ...secondaryButton(), width: "100%", marginTop: 10 }}>登出</button>
      </aside>

      {mode === "explore" ? (
        <ExploreView loading={publicLoading} rooms={publicRooms} onOpen={openPublicRoom} />
      ) : mode === "topFavorites" ? (
        <RankingPage title="🏆 排行榜" items={topFavoriteItems} onSelect={(entry) => { setRankingSelected({ ...entry.item, location: entry.location, ownerName: entry.ownerName, roomName: entry.roomName }); loadComments(entry.item.cloudId); }} onOpenPreview={openImagePreview} />
      ) : mode === "latestFavorites" ? (
        <RankingPage title="🆕 最新上架" items={latestFavoriteItems} onSelect={(entry) => { setRankingSelected({ ...entry.item, location: entry.location, ownerName: entry.ownerName, roomName: entry.roomName }); loadComments(entry.item.cloudId); }} onOpenPreview={openImagePreview} />
      ) : mode === "favorites" ? (
        <FavoritesView favorites={favorites} onOpenPreview={openImagePreview} onRemoveFavorite={toggleFavorite} />
      ) : (
        <ShowroomView rack={activeRack} readOnly={readOnly} highlight={highlight} onSlotClick={openUpload} onSelectItem={readOnly ? selectPublicItem : selectItem} viewingRoom={viewingRoom} compact={isCompactDesktop} cabinetCount={cabinetCount} roomSettings={roomSettings} updateCabinetPrivacy={updateCabinetPrivacy} setCabinetCount={changeCabinetCount} />
      )}

      <RightPanel
        mode={mode}
        profileName={profileName}
        setProfileName={setProfileName}
        saveProfileName={saveProfileName}
        cabinetCount={viewingRoom?.cabinet_count || cabinetCount}
        selected={activeSelected}
        isEditingMeta={isEditingMeta}
        setIsEditingMeta={setIsEditingMeta}
        updateSelectedField={updateSelectedField}
        saveAllSettings={saveAllSettings}
        deleteSelectedItem={deleteSelectedItem}
        extraInputRef={extraInputRef}
        removeExtraImage={removeExtraImage}
        setPreviewImage={openImagePreview}
        rack={activeRack}
        readOnly={readOnly}
        viewingRoom={viewingRoom}
        isFavorite={activeSelected?.cloudId ? favoriteIds.has(activeSelected.cloudId) : false}
        favoriteCount={activeSelected?.cloudId ? (favoriteCounts[activeSelected.cloudId] || 0) : 0}
        isLiked={activeSelected?.cloudId ? likedIds.has(activeSelected.cloudId) : false}
        likeCount={activeSelected?.cloudId ? (likeCounts[activeSelected.cloudId] || 0) : 0}
        commentCount={activeSelected?.cloudId ? (commentCounts[activeSelected.cloudId] || 0) : 0}
        comments={comments}
        commentInput={commentInput}
        setCommentInput={setCommentInput}
        toggleFavorite={toggleFavorite}
        toggleLike={toggleLike}
        addComment={addComment}
      />

      {previewIndex !== null && previewImages[previewIndex] && (
        <ImageModal src={previewImages[previewIndex]} total={previewImages.length} index={previewIndex} onClose={closeImagePreview} onPrev={showPrevImage} onNext={showNextImage} />
      )}
      {sponsorAdOpen && <SponsorAdModal countdown={sponsorAdCountdown} onClose={closeSponsorAd} />}
      
    </div>
  );
}

function MobileLayout({
  user,
  mode,
  setMode,
  profileName,
  setProfileName,
  saveProfileName,
  roomSettings,
  cabinetCount,
  setCabinetCount,
  updateCabinetPrivacy,
  useFreeRemoveBg,
  toggleFreeRemoveBg,
  bgTolerance,
  updateTolerance,
  processMessage,
  syncMessage,
  processing,
  loadCloudRack,
  loadFavorites,
  loadPublicRooms,
  logout,
  resetAllData,
  activeRack,
  activeSelected,
  readOnly,
  highlight,
  openUpload,
  selectItem,
  viewingRoom,
  publicLoading,
  publicRooms,
  openPublicRoom,
  favorites,
  openImagePreview,
  toggleFavorite,
  favoriteCounts,
  likedIds,
  likeCounts,
  commentCounts,
  comments,
  commentInput,
  setCommentInput,
  toggleLike,
  addComment,
  loadSocialStats,
  loadComments,
  setRankingSelected,
  topFavoriteItems,
  latestFavoriteItems,
  isFavorite,
  isEditingMeta,
  setIsEditingMeta,
  updateSelectedField,
  saveAllSettings,
  deleteSelectedItem,
  extraInputRef,
  removeExtraImage,
  fileInputRef,
  handleUpload,
  handleExtraUpload,
  onCloseMobileDetail,
  previewIndex,
  previewImages,
  closeImagePreview,
  showPrevImage,
  showNextImage,
  sponsorAdOpen,
  sponsorAdCountdown,
  closeSponsorAd,
}) {
  return (
    <div style={{ minHeight: "100vh", background: "#07090d", color: "white", fontFamily: "Arial, sans-serif", overflowX: "hidden" }}>
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUpload} style={{ display: "none" }} />
      <input ref={extraInputRef} type="file" accept="image/*" multiple onChange={handleExtraUpload} style={{ display: "none" }} />

      <div style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(4,7,11,0.96)", backdropFilter: "blur(12px)", borderBottom: "1px solid #171b22", padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1 }}>GK ROOM</div>
            <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>{profileName}</div>
          </div>
          <button onClick={logout} style={{ ...secondaryButton(), width: 70 }}>登出</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <button onClick={() => setMode("mine")} style={navButton(mode === "mine")}>我的</button>
          <button onClick={loadFavorites} style={navButton(mode === "favorites")}>收藏</button>
          <button onClick={loadPublicRooms} style={navButton(mode === "explore" || mode === "publicRoom")}>公開</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <button onClick={() => { setMode("topFavorites"); setRankingSelected(null); loadSocialStats(); }} style={navButton(mode === "topFavorites")}>排行榜</button>
          <button onClick={() => { setMode("latestFavorites"); setRankingSelected(null); loadSocialStats(); }} style={navButton(mode === "latestFavorites")}>最新上架</button>
        </div>
      </div>

      {mode === "mine" && (
        <div style={{ padding: 12, display: "grid", gap: 12 }}>
          <div style={panelBox()}>
            <div style={{ fontSize: 13, color: "#e5e7eb", marginBottom: 10, fontWeight: 800 }}>展示名稱</div>
            <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="輸入你的展示名稱" style={{ ...textInputStyle(), height: 38, marginBottom: 10 }} />
            <button onClick={saveProfileName} style={{ ...secondaryButton(), width: "100%" }}>儲存名稱</button>
          </div>
          <div style={panelBox()}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 10, color: "#cbd5e1" }}>
              <input type="checkbox" checked={useFreeRemoveBg} onChange={(e) => toggleFreeRemoveBg(e.target.checked)} />上傳時自動去背
            </label>
            <RangeControl label="去背強度" value={bgTolerance} min={35} max={130} step={1} onChange={updateTolerance} />
            {processMessage && <div style={{ color: processing ? "#93c5fd" : "#9ca3af", fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>{processMessage}</div>}
            {syncMessage && <div style={{ color: "#86efac", fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>{syncMessage}</div>}
          </div>
          <SponsorCard />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={loadCloudRack} style={secondaryButton()}>重新同步</button>
            <button onClick={resetAllData} style={dangerButton()}>清空資料</button>
          </div>
        </div>
      )}

      {mode === "explore" ? (
        <ExploreView loading={publicLoading} rooms={publicRooms} onOpen={openPublicRoom} />
      ) : mode === "topFavorites" ? (
        <RankingPage title="🏆 排行榜" items={topFavoriteItems} onSelect={(entry) => { setRankingSelected({ ...entry.item, location: entry.location, ownerName: entry.ownerName, roomName: entry.roomName }); loadComments(entry.item.cloudId); }} onOpenPreview={openImagePreview} />
      ) : mode === "latestFavorites" ? (
        <RankingPage title="🆕 最新上架" items={latestFavoriteItems} onSelect={(entry) => { setRankingSelected({ ...entry.item, location: entry.location, ownerName: entry.ownerName, roomName: entry.roomName }); loadComments(entry.item.cloudId); }} onOpenPreview={openImagePreview} />
      ) : mode === "favorites" ? (
        <FavoritesView favorites={favorites} onOpenPreview={openImagePreview} onRemoveFavorite={toggleFavorite} />
      ) : (
        <MobileRackView rack={activeRack} readOnly={readOnly} highlight={highlight} onSlotClick={openUpload} onSelectItem={selectItem} viewingRoom={viewingRoom} cabinetCount={viewingRoom?.cabinet_count || cabinetCount} roomSettings={viewingRoom || roomSettings} updateCabinetPrivacy={updateCabinetPrivacy} setCabinetCount={setCabinetCount} />
      )}

      {mode !== "explore" && mode !== "favorites" && activeSelected && (
        <MobileDetailSheet
          selected={activeSelected}
          onClose={onCloseMobileDetail}
          readOnly={readOnly}
          isEditingMeta={isEditingMeta}
          setIsEditingMeta={setIsEditingMeta}
          updateSelectedField={updateSelectedField}
          saveAllSettings={saveAllSettings}
          deleteSelectedItem={deleteSelectedItem}
          extraInputRef={extraInputRef}
          removeExtraImage={removeExtraImage}
          setPreviewImage={openImagePreview}
          isFavorite={isFavorite}
          favoriteCount={activeSelected?.cloudId ? (favoriteCounts?.[activeSelected.cloudId] || 0) : 0}
          isLiked={activeSelected?.cloudId ? likedIds?.has(activeSelected.cloudId) : false}
          likeCount={activeSelected?.cloudId ? (likeCounts?.[activeSelected.cloudId] || 0) : 0}
          commentCount={activeSelected?.cloudId ? (commentCounts?.[activeSelected.cloudId] || 0) : 0}
          comments={comments}
          commentInput={commentInput}
          setCommentInput={setCommentInput}
          toggleFavorite={toggleFavorite}
          toggleLike={toggleLike}
          addComment={addComment}
        />
      )}

      {previewIndex !== null && previewImages[previewIndex] && (
        <ImageModal src={previewImages[previewIndex]} total={previewImages.length} index={previewIndex} onClose={closeImagePreview} onPrev={showPrevImage} onNext={showNextImage} />
      )}
      {sponsorAdOpen && <SponsorAdModal countdown={sponsorAdCountdown} onClose={closeSponsorAd} />}
      
    </div>
  );
}

function RoomPreview({ images = [] }) {
  const slots = [0, 1, 2];
  return (
    <div
      style={{
        height: 118,
        borderRadius: 14,
        border: "1px solid #1f2937",
        background: "linear-gradient(180deg, #211813 0%, #17110d 34%, #0b0f15 35%, #090b10 100%)",
        marginBottom: 14,
        position: "relative",
        overflow: "hidden",
        boxShadow: "inset 0 18px 40px rgba(255,200,130,0.12), inset 0 -18px 34px rgba(0,0,0,0.72)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 22%, rgba(255,210,150,0.32), transparent 48%)" }} />
      <div style={{ position: "absolute", left: 10, right: 10, bottom: 18, height: 12, background: "linear-gradient(180deg, #8b5a35, #3a2417)", borderTop: "1px solid rgba(255,255,255,0.20)", borderBottom: "1px solid rgba(0,0,0,0.65)", zIndex: 2 }} />
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 13, background: "linear-gradient(90deg, #05070b, #171b22)", zIndex: 3 }} />
      <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 13, background: "linear-gradient(270deg, #05070b, #171b22)", zIndex: 3 }} />
      {slots.map((slot) => {
        const item = images[slot];
        return (
          <div
            key={slot}
            style={{
              position: "absolute",
              left: `${20 + slot * 30}%`,
              bottom: 24,
              transform: "translateX(-50%)",
              width: "25%",
              height: 76,
              borderRadius: 10,
              border: "1px dashed rgba(255,255,255,0.16)",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              zIndex: 4,
              overflow: "visible",
            }}
          >
            {item ? (
              <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", overflow: "visible" }}>
                <img
                  src={item.image}
                  loading="lazy"
                  decoding="async"
                  alt="room shelf preview"
                  style={{ width: "100%", height: "112%", objectFit: "contain", filter: "drop-shadow(0 10px 14px rgba(0,0,0,0.50))", transform: "translateY(4px)" }}
                />
                {item.isAdult && (
                  <div style={{ position: "absolute", left: "50%", top: "48%", transform: "translate(-50%, -50%)", minWidth: 42, height: 26, lineHeight: "26px", textAlign: "center", padding: "0 8px", borderRadius: 999, background: "rgba(0,0,0,0.82)", color: "white", fontWeight: 950, fontSize: 13, boxShadow: "0 8px 20px rgba(0,0,0,0.45)", whiteSpace: "nowrap" }}>18+</div>
                )}
              </div>
            ) : (
              <span style={{ color: "rgba(255,255,255,0.32)", fontSize: 22, marginBottom: 18 }}>＋</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SponsorCard() {
  return (
    <div style={{ ...panelBox(), marginTop: 12 }}>
      <div style={{ color: "#e5e7eb", fontSize: 13, fontWeight: 900, marginBottom: 8 }}>贊助位置</div>
      <div style={{ borderRadius: 12, border: "1px dashed #334155", background: "linear-gradient(135deg, #111827, #06080d)", padding: 12, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: "#facc15" }}>本月贊助</div>
        <div style={{ color: "#cbd5e1", fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>GK 店家 / 防塵盒 / 燈條 / 代工 / 3D列印</div>
        <div style={{ color: "#64748b", fontSize: 11, marginTop: 8 }}>可放 LOGO、圖片、優惠碼或聯絡方式</div>
      </div>
    </div>
  );
}

function SponsorAdModal({ countdown, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 22, boxSizing: "border-box" }}>
      <div style={{ width: "min(520px, 94vw)", borderRadius: 24, border: "1px solid rgba(255,255,255,0.16)", background: "linear-gradient(160deg, #111827, #05070b)", boxShadow: "0 30px 120px rgba(0,0,0,0.72)", padding: 22, position: "relative", color: "white", boxSizing: "border-box" }}>
        <button onClick={onClose} disabled={countdown > 0} style={{ position: "absolute", top: 14, right: 14, width: 36, height: 36, borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)", background: countdown > 0 ? "rgba(30,41,59,0.6)" : "rgba(15,23,42,0.95)", color: countdown > 0 ? "#64748b" : "white", cursor: countdown > 0 ? "not-allowed" : "pointer", fontSize: 18 }}>{countdown > 0 ? countdown : "×"}</button>
        <div style={{ color: "#facc15", fontSize: 13, fontWeight: 900, marginBottom: 8 }}>SPONSOR</div>
        <div style={{ fontSize: 28, fontWeight: 950, marginBottom: 10 }}>本月贊助商</div>
        <div style={{ height: 190, borderRadius: 18, border: "1px dashed #334155", background: "radial-gradient(circle at top, #1e293b, #07090d 70%)", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "#cbd5e1", padding: 18, boxSizing: "border-box", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#ffffff" }}>你的 GK 廣告位</div>
            <div style={{ fontSize: 14, lineHeight: 1.7, marginTop: 8 }}>可放店家 LOGO、商品圖、優惠碼、LINE 或官網連結</div>
          </div>
        </div>
        <div style={{ color: "#9ca3af", fontSize: 13, lineHeight: 1.7 }}>適合：GK 店家、防塵盒、燈條、模型工具、代工、3D列印服務。</div>
        <button onClick={onClose} disabled={countdown > 0} style={{ ...primaryButton(), width: "100%", marginTop: 18, opacity: countdown > 0 ? 0.55 : 1 }}>{countdown > 0 ? `${countdown} 秒後可關閉` : "進入 GK ROOM"}</button>
      </div>
    </div>
  );
}

function MobileRackView({ rack, readOnly, highlight, onSlotClick, onSelectItem, viewingRoom, cabinetCount = MIN_CABINETS, roomSettings, updateCabinetPrivacy, setCabinetCount }) {
  const publicCabinets = normalizePublicCabinets(roomSettings?.public_cabinets || [roomSettings?.public_left, roomSettings?.public_right, roomSettings?.public_third]);
  const sourceCabinets = Array.from({ length: cabinetCount }, (_, index) => ({
    title: cabinetTitle(index),
    start: slotStartByCabinet(index),
    side: index,
    checked: publicCabinets[index],
    index,
  }));
  const cabinets = readOnly ? sourceCabinets.filter((cabinet) => cabinet.checked) : sourceCabinets;

  return (
    <main style={{ padding: "12px 12px 220px", boxSizing: "border-box" }}>
      {viewingRoom && <div style={{ ...panelBox(), marginBottom: 12, fontWeight: 800 }}>{viewingRoom.room_name || "公開展示櫃"}</div>}
      {cabinets.map((cabinet) => (
        <MobileCabinetBlock
          key={cabinet.start}
          title={cabinet.title}
          rack={rack}
          start={cabinet.start}
          readOnly={readOnly}
          highlight={highlight}
          onSlotClick={onSlotClick}
          onSelectItem={onSelectItem}
          publicChecked={cabinet.checked}
          onPublicChange={(v) => updateCabinetPrivacy?.(cabinet.side, v)}
          canAdd={!readOnly && cabinet.index === cabinetCount - 1 && cabinetCount < MAX_CABINETS}
          canRemove={!readOnly && cabinet.index === cabinetCount - 1 && cabinetCount > MIN_CABINETS}
          onAdd={() => setCabinetCount?.(cabinetCount + 1)}
          onRemove={() => setCabinetCount?.(cabinetCount - 1)}
        />
      ))}
    </main>
  );
}

function MobileCabinetBlock({ title, rack, start, readOnly, highlight, onSlotClick, onSelectItem, publicChecked, onPublicChange, canAdd, canRemove, onAdd, onRemove }) {
  // 手機版使用單櫃背景圖，不再用 grid 硬切位置。
  // 這些百分比是依照 single-rack-ui.png 重新校正：
  // x = 三格中心點；y = 每層木板的擺放基準線。
  const mobileColumns = [24.8, 50, 75.2];
  const mobileShelfBaseY = [37.2, 65.3, 89.1];
  const mobileSlot = { width: 23.2, height: 20.5 };

  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ color: "#e5e7eb", fontSize: 15, fontWeight: 900 }}>{title}</div>
        {!readOnly && <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ color: "#9ca3af", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={!!publicChecked} onChange={(e) => onPublicChange?.(e.target.checked)} />公開</label>
          {canAdd && <button onClick={onAdd} title="增加一櫃" style={cabinetMiniButton()}>＋</button>}
          {canRemove && <button onClick={onRemove} title="減少一櫃" style={cabinetMiniButton()}>－</button>}
        </div>}
      </div>

      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1024 / 1365",
          borderRadius: 20,
          border: "1px solid #1f2937",
          backgroundImage: `linear-gradient(rgba(3,7,18,0.04), rgba(3,7,18,0.18)), url(${MOBILE_RACK_IMAGE})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: "100% 100%",
          backgroundPosition: "center center",
          boxShadow: "0 20px 55px rgba(0,0,0,0.38)",
          overflow: "hidden",
        }}
      >
        {rack.map((row, shelfIndex) =>
          [0, 1, 2].map((i) => {
            const slotIndex = start + i;
            const item = row[slotIndex];
            const highlighted = item && highlight === item.id;
            const x = mobileColumns[i];
            const y = mobileShelfBaseY[shelfIndex];

            return (
              <div
                key={`mobile-${shelfIndex}-${slotIndex}`}
                style={{
                  position: "absolute",
                  left: `${x}%`,
                  top: `${y}%`,
                  transform: "translate(-50%, -100%)",
                  width: `${mobileSlot.width}%`,
                  height: `${mobileSlot.height}%`,
                  borderRadius: 14,
                  overflow: "visible",
                }}
              >
                {item ? (
                  <GKStand item={item} highlighted={highlighted} readOnly={readOnly} onSelect={() => onSelectItem(item, shelfIndex, slotIndex)} />
                ) : readOnly ? (
                  <div style={{ width: "100%", height: "100%" }} />
                ) : (
                  <button onClick={() => onSlotClick(shelfIndex, slotIndex)} style={{ width: "100%", height: "100%", border: "1px dashed rgba(255,255,255,0.24)", background: "rgba(0,0,0,0.06)", color: "rgba(255,255,255,0.50)", borderRadius: 14, fontSize: 24 }}>＋</button>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function MobileDetailSheet({ selected, onClose, readOnly, isEditingMeta, setIsEditingMeta, updateSelectedField, saveAllSettings, deleteSelectedItem, extraInputRef, removeExtraImage, setPreviewImage, isFavorite, favoriteCount = 0, isLiked = false, likeCount = 0, commentCount = 0, comments = [], commentInput = "", setCommentInput, toggleFavorite, toggleLike, addComment }) {
  const touchStartYRef = useRef(0);
  const touchCurrentYRef = useRef(0);
  const [dragY, setDragY] = useState(0);

  function handleTouchStart(e) {
    touchStartYRef.current = e.touches[0].clientY;
    touchCurrentYRef.current = e.touches[0].clientY;
  }

  function handleTouchMove(e) {
    const target = e.target;
    if (target?.closest?.("input, textarea, button, [data-no-drag='true']")) return;
    touchCurrentYRef.current = e.touches[0].clientY;
    const diff = Math.max(0, touchCurrentYRef.current - touchStartYRef.current);
    setDragY(Math.min(diff, 180));
  }

  function handleTouchEnd(e) {
    const target = e.target;
    if (target?.closest?.("input, textarea, button, [data-no-drag='true']")) {
      setDragY(0);
      return;
    }
    if (dragY > 90) onClose?.();
    setDragY(0);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0,0,0,0.42)",
        display: "flex",
        alignItems: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          width: "100%",
          background: "rgba(4,7,11,0.98)",
          borderTop: "1px solid #1f2937",
          borderRadius: "22px 22px 0 0",
          padding: 14,
          maxHeight: "66vh",
          overflowY: "auto",
          boxShadow: "0 -20px 70px rgba(0,0,0,0.55)",
          transform: `translateY(${dragY}px)`,
          transition: dragY ? "none" : "transform 180ms ease",
          boxSizing: "border-box",
        }}
      >
      <div style={{ width: 44, height: 4, borderRadius: 999, background: "#374151", margin: "0 auto 12px" }} />
      <button
        onClick={onClose}
        style={{
          position: "absolute",
          top: 12,
          right: 14,
          width: 34,
          height: 34,
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(15,23,42,0.9)",
          color: "white",
          fontSize: 18,
          cursor: "pointer",
          zIndex: 2,
        }}
      >×</button>
      <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <img src={selected.image} loading="lazy" decoding="async" alt={selected.name || "GK"} style={{ width: 88, height: 88, objectFit: "contain", borderRadius: 12, background: "#11141a" }} />
        <div>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{selected.name || "未命名GK"}</div>
          <div style={{ color: "#cbd5e1", fontSize: 13, marginTop: 4 }}>{selected.studio || "未填寫工作室"}</div>
          <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>{selected.location}</div>
          <div style={{ color: "#fda4af", fontSize: 12, marginTop: 4, fontWeight: 800 }}>⭐ 收藏 {favoriteCount}　❤️ 讚 {likeCount}　💬 留言 {commentCount}</div>
        </div>
      </div>
      {!readOnly && isEditingMeta ? (
        <div style={{ display: "grid", gap: 10 }}>
          <TextInput value={selected.name || ""} onChange={(e) => updateSelectedField("name", e.target.value)} placeholder="請填寫 GK 名稱" />
          <TextInput value={selected.studio || ""} onChange={(e) => updateSelectedField("studio", e.target.value)} placeholder="請填寫工作室名稱" />
                <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#fca5a5", fontSize: 13, fontWeight: 800 }}>
                  <input type="checkbox" checked={!!selected.isAdult} onChange={(e) => updateSelectedField("isAdult", e.target.checked)} />18禁 / 成人向內容
                </label>
          <RangeControl label="大小" value={selected.scale ?? 1} min={0.6} max={1.6} step={0.01} onChange={(v) => updateSelectedField("scale", v)} />
          <RangeControl label="左右" value={selected.offsetX ?? 0} min={-40} max={40} step={1} onChange={(v) => updateSelectedField("offsetX", v)} />
          <RangeControl label="上下" value={selected.offsetY ?? 0} min={-40} max={40} step={1} onChange={(v) => updateSelectedField("offsetY", v)} />
          <button onClick={() => extraInputRef.current?.click()} style={secondaryButton()}>上傳細節圖片</button>
          <DetailGrid images={selected.extraImages || []} editable onRemove={removeExtraImage} onPreview={setPreviewImage} />
          <button onClick={saveAllSettings} style={primaryButton()}>儲存到雲端</button>
        </div>
      ) : (
        <div data-no-drag="true" style={{ display: "grid", gap: 10 }}>
          <DetailGrid images={[selected.image, ...(selected.extraImages || [])]} onPreview={setPreviewImage} />
          {readOnly && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={() => toggleLike?.(selected)} style={{ ...primaryButton(), background: isLiked ? "#be123c" : "#374151" }}>{isLiked ? "❤️ 已讚" : "♡ 讚"}</button>
            <button onClick={() => toggleFavorite(selected)} style={{ ...primaryButton(), background: isFavorite ? "#7c3aed" : "#2563eb" }}>{isFavorite ? "⭐ 已收藏" : "☆ 收藏"}</button>
          </div>}
          {readOnly && <CommentBox comments={comments} commentInput={commentInput} setCommentInput={setCommentInput} onSubmit={() => addComment?.(selected)} />}
          {!readOnly && <button onClick={() => setIsEditingMeta(true)} style={secondaryButton()}>重新編輯資料 / 位置</button>}
          {!readOnly && <button onClick={deleteSelectedItem} style={dangerButton()}>刪除此 GK</button>}
        </div>
      )}
      </div>
    </div>
  );
}

function PrivacyToggle({ label, checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, color: "#cbd5e1", fontSize: 13, marginBottom: 10 }}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function ShowroomView({ rack, readOnly, highlight, onSlotClick, onSelectItem, viewingRoom, compact = false, cabinetCount = MIN_CABINETS, roomSettings, updateCabinetPrivacy, setCabinetCount }) {
  const publicCabinets = normalizePublicCabinets((viewingRoom?.public_cabinets || roomSettings?.public_cabinets) || [roomSettings?.public_left, roomSettings?.public_right, roomSettings?.public_third]);
  const count = viewingRoom?.cabinet_count || cabinetCount;
  const sourceCabinets = Array.from({ length: count }, (_, index) => ({
    title: cabinetTitle(index),
    start: slotStartByCabinet(index),
    side: index,
    checked: publicCabinets[index],
    index,
  }));
  const cabinets = readOnly ? sourceCabinets.filter((cabinet) => cabinet.checked) : sourceCabinets;

  return (
    <main style={{ flex: 1, padding: compact ? 18 : "14px 18px", boxSizing: "border-box", overflow: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 1240 }}>
        {viewingRoom && <div style={{ ...panelBox(), marginBottom: 12, fontWeight: 800 }}>{viewingRoom.room_name || "公開展示櫃"}</div>}
        <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "repeat(2, minmax(0, 1fr))", gap: 18, alignItems: "start", justifyContent: "center" }}>
          {cabinets.map((cabinet) => (
            <ResponsiveCabinetBlock
              key={cabinet.start}
              title={cabinet.title}
              rack={rack}
              start={cabinet.start}
              readOnly={readOnly}
              highlight={highlight}
              onSlotClick={onSlotClick}
              onSelectItem={onSelectItem}
              publicChecked={cabinet.checked}
              onPublicChange={(v) => updateCabinetPrivacy?.(cabinet.side, v)}
              canAdd={!readOnly && cabinet.index === count - 1 && count < MAX_CABINETS}
              canRemove={!readOnly && cabinet.index === count - 1 && count > MIN_CABINETS}
              onAdd={() => setCabinetCount?.(count + 1)}
              onRemove={() => setCabinetCount?.(count - 1)}
            />
          ))}
        </div>
      </div>
    </main>
  );
}

function ResponsiveCabinetBlock({ title, rack, start, readOnly, highlight, onSlotClick, onSelectItem, publicChecked, onPublicChange, canAdd, canRemove, onAdd, onRemove }) {
  const columns = [24.8, 50, 75.2];
  const shelfBaseY = [37.2, 65.3, 89.1];
  const slot = { width: 23.2, height: 20.5 };

  return (
    <section style={{ width: "min(100%, 600px)", flex: "1 1 0", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ color: "#e5e7eb", fontSize: 15, fontWeight: 900 }}>{title}</div>
        {!readOnly && <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ color: "#9ca3af", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={!!publicChecked} onChange={(e) => onPublicChange?.(e.target.checked)} />公開</label>
          {canAdd && <button onClick={onAdd} title="增加一櫃" style={cabinetMiniButton()}>＋</button>}
          {canRemove && <button onClick={onRemove} title="減少一櫃" style={cabinetMiniButton()}>－</button>}
        </div>}
      </div>
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1024 / 1365",
          borderRadius: 20,
          border: "1px solid #1f2937",
          backgroundImage: `linear-gradient(rgba(3,7,18,0.04), rgba(3,7,18,0.18)), url(${MOBILE_RACK_IMAGE})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: "100% 100%",
          backgroundPosition: "center center",
          boxShadow: "0 20px 55px rgba(0,0,0,0.38)",
          overflow: "hidden",
        }}
      >
        {rack.map((row, shelfIndex) =>
          [0, 1, 2].map((i) => {
            const slotIndex = start + i;
            const item = row[slotIndex];
            const highlighted = item && highlight === item.id;
            const x = columns[i];
            const y = shelfBaseY[shelfIndex];
            return (
              <div
                key={`desktop-rack-${start}-${shelfIndex}-${slotIndex}`}
                style={{
                  position: "absolute",
                  left: `${x}%`,
                  top: `${y}%`,
                  transform: "translate(-50%, -100%)",
                  width: `${slot.width}%`,
                  height: `${slot.height}%`,
                  borderRadius: 14,
                  overflow: "visible",
                }}
              >
                {item ? (
                  <GKStand item={item} highlighted={highlighted} readOnly={readOnly} onSelect={() => onSelectItem(item, shelfIndex, slotIndex)} />
                ) : readOnly ? (
                  <div style={{ width: "100%", height: "100%" }} />
                ) : (
                  <button onClick={() => onSlotClick(shelfIndex, slotIndex)} style={{ width: "100%", height: "100%", border: "1px dashed rgba(255,255,255,0.24)", background: "rgba(0,0,0,0.06)", color: "rgba(255,255,255,0.50)", borderRadius: 14, fontSize: 24 }}>＋</button>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function ExploreView({ loading, rooms, onOpen }) {
  return (
    <main style={{ flex: 1, padding: 26, overflowY: "auto", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 22 }}>
          <div>
            <div style={{ fontSize: 30, fontWeight: 900, marginBottom: 8 }}>探索 GK ROOM</div>
            <div style={{ color: "#9ca3af" }}>看看其他玩家公開的 GK 展示櫃。私密櫃不會出現在這裡。</div>
          </div>
          <div style={{ color: "#6b7280", fontSize: 13 }}>公開展櫃：{rooms.length}</div>
        </div>
        {loading ? (
          <div style={emptyTextStyle()}>正在載入公開展示櫃...</div>
        ) : rooms.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
            {rooms.map((room) => (
              <button key={room.id} onClick={() => onOpen(room)} style={roomCardStyle()}>
                <RoomPreview images={room.previewImages || []} />
                <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 8 }}>{room.room_name || `${room.profiles?.username || "GK玩家"} 的 GK ROOM`}</div>
                <div style={{ color: "#9ca3af", fontSize: 13 }}>By {room.profiles?.username || "GK玩家"}</div>
                <div style={{ color: "#9ca3af", fontSize: 13, marginTop: 8 }}>公開範圍：{room.public_left ? "第一櫃 " : ""}{room.public_right ? "第二櫃 " : ""}{room.public_third ? "第三櫃" : ""}</div>
                <div style={{ marginTop: 18, color: "#a5b4fc", fontSize: 13, fontWeight: 800 }}>進入展示櫃 →</div>
              </button>
            ))}
          </div>
        ) : (
          <div style={emptyTextStyle()}>目前還沒有其他公開展示櫃。<br />你可以先用另一個信箱註冊測試帳號，放幾隻 GK 後把左櫃或右櫃設為公開。</div>
        )}
      </div>
    </main>
  );
}

function RankingPage({ title, items, onSelect, onOpenPreview }) {
  return (
    <main style={{ flex: 1, padding: 26, overflowY: "auto", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ fontSize: 30, fontWeight: 900, marginBottom: 8 }}>{title}</div>
        <div style={{ color: "#9ca3af", marginBottom: 22 }}>{title.includes("最新") ? "依照每個用戶上傳 GK 的時間排序。" : "依照玩家收藏數自動排序。"}</div>
        {items.length ? <RankingSection title={title} items={items} onSelect={onSelect} onOpenPreview={onOpenPreview} /> : <div style={emptyTextStyle()}>目前還沒有資料。</div>}
      </div>
    </main>
  );
}

function RankingSection({ title, items, onSelect, onOpenPreview }) {
  if (!items.length) return null;
  return (
    <section>
      <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 12 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
        {items.map((entry, index) => (
          <button key={`${title}-${entry.item.cloudId || entry.item.id}-${index}`} onClick={() => onSelect?.(entry)} style={{ textAlign: "left", border: "1px solid #1f2937", background: "linear-gradient(135deg, #0b0f15, #111827)", borderRadius: 16, padding: 12, color: "white", cursor: "pointer" }}>
            <img src={entry.item.image} loading="lazy" decoding="async" alt={entry.item.name} style={{ width: "100%", height: 130, objectFit: "contain", borderRadius: 12, background: "#11141a", marginBottom: 10 }} />
            <div style={{ fontWeight: 900, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.item.name || "未命名GK"}</div>
            <div style={{ color: "#9ca3af", fontSize: 12, marginTop: 5 }}>By {entry.ownerName}</div>
            <div style={{ color: "#fda4af", fontSize: 12, marginTop: 6 }}>⭐ {entry.count || 0} 收藏　❤️ {entry.likeCount || 0} 讚　💬 {entry.commentCount || 0}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

function FavoritesView({ favorites, onOpenPreview, onRemoveFavorite }) {
  return (
    <main style={{ flex: 1, padding: 26, overflowY: "auto", boxSizing: "border-box" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ fontSize: 30, fontWeight: 900, marginBottom: 8 }}>收藏管理</div>
        <div style={{ color: "#9ca3af", marginBottom: 22 }}>你在公開展櫃收藏的 GK 會出現在這裡，並標示來源展示櫃。</div>
        {favorites.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
            {favorites.map((fav) => (
              <div key={fav.favoriteId} style={roomCardStyle()}>
                <button onClick={() => onOpenPreview([fav.item.image, ...(fav.item.extraImages || [])], 0)} style={{ width: "100%", padding: 0, border: "1px solid #1f2937", borderRadius: 14, background: "#11141a", overflow: "hidden", cursor: "pointer" }}>
                  <img src={fav.item.image} loading="lazy" decoding="async" alt={fav.item.name} style={{ width: "100%", height: 160, objectFit: "contain", display: "block" }} />
                </button>
                <div style={{ fontSize: 18, fontWeight: 900, marginTop: 12 }}>{fav.item.name || "未命名GK"}</div>
                <div style={{ color: "#cbd5e1", fontSize: 13, marginTop: 6 }}>{fav.item.studio || "未填寫工作室"}</div>
                <div style={{ color: "#9ca3af", fontSize: 13, marginTop: 10 }}>來源：{fav.ownerName} / {fav.roomName}</div>
                <div style={{ color: "#6b7280", fontSize: 12, marginTop: 6 }}>位置：{fav.location}</div>
                <button onClick={() => onRemoveFavorite(fav.item)} style={{ ...dangerButton(), marginTop: 14 }}>取消收藏</button>
              </div>
            ))}
          </div>
        ) : (
          <div style={emptyTextStyle()}>目前還沒有收藏。到公開展櫃點別人的 GK，再按愛心收藏。</div>
        )}
      </div>
    </main>
  );
}

function RightPanel({ mode, profileName, setProfileName, saveProfileName, cabinetCount = MIN_CABINETS, selected, isEditingMeta, setIsEditingMeta, updateSelectedField, saveAllSettings, deleteSelectedItem, extraInputRef, removeExtraImage, setPreviewImage, rack, readOnly, viewingRoom, isFavorite, favoriteCount = 0, isLiked = false, likeCount = 0, commentCount = 0, comments = [], commentInput = "", setCommentInput, toggleFavorite, toggleLike, addComment }) {
  return (
    <aside style={rightAsideStyle()}>
      <div style={{ minHeight: 104, borderRadius: 16, background: "linear-gradient(135deg, #111827, #0b0f15)", border: "1px solid #171b22", padding: 14, boxSizing: "border-box", display: "grid", gridTemplateColumns: mode === "mine" ? "0.85fr 1.15fr" : "1fr", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 14, color: "#9ca3af" }}>{mode === "publicRoom" ? "正在瀏覽" : mode === "favorites" ? "收藏數量" : "收藏狀態"}</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>{mode === "publicRoom" ? (viewingRoom?.room_name || "公開展示櫃") : `${countItems(rack)} / ${(viewingRoom?.cabinet_count || Math.max(MIN_CABINETS, cabinetCount || MIN_CABINETS)) * SLOTS_PER_CABINET * 3}`}</div>
        </div>
        {mode === "mine" && (
          <div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 6, fontWeight: 800 }}>展示名稱</div>
            <input value={profileName || ""} onChange={(e) => setProfileName?.(e.target.value)} placeholder="輸入展示名稱" style={{ ...textInputStyle(), height: 34, marginBottom: 8, fontSize: 12 }} />
            <button onClick={saveProfileName} style={{ ...secondaryButton(), width: "100%", height: 32, fontSize: 12 }}>儲存名稱</button>
          </div>
        )}
      </div>
      <div style={{ fontSize: 16, fontWeight: 800 }}>{readOnly ? "GK資訊" : "展示GK"}</div>
      <div style={detailBoxStyle()}>
        {selected ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <img src={selected.image} loading="lazy" decoding="async" alt={selected.name || "GK"} style={{ width: "100%", height: 210, objectFit: "contain", borderRadius: 14, background: "#11141a" }} />
            {!readOnly && isEditingMeta ? (
              <>
                <TextInput value={selected.name || ""} onChange={(e) => updateSelectedField("name", e.target.value)} placeholder="請填寫 GK 名稱" />
                <TextInput value={selected.studio || ""} onChange={(e) => updateSelectedField("studio", e.target.value)} placeholder="請填寫工作室名稱" />
                <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#fca5a5", fontSize: 13, fontWeight: 800 }}>
                  <input type="checkbox" checked={!!selected.isAdult} onChange={(e) => updateSelectedField("isAdult", e.target.checked)} />18禁 / 成人向內容
                </label>
                <div style={sectionTitle()}>位置校正</div>
                <RangeControl label="大小" value={selected.scale ?? 1} min={0.6} max={1.6} step={0.01} onChange={(v) => updateSelectedField("scale", v)} />
                <RangeControl label="左右" value={selected.offsetX ?? 0} min={-40} max={40} step={1} onChange={(v) => updateSelectedField("offsetX", v)} />
                <RangeControl label="上下" value={selected.offsetY ?? 0} min={-40} max={40} step={1} onChange={(v) => updateSelectedField("offsetY", v)} />
                <div style={sectionTitle()}>細節圖片 {(selected.extraImages?.length || 0) + 1} / 6</div>
                <button onClick={() => extraInputRef.current?.click()} style={secondaryButton()}>上傳細節圖片</button>
                <DetailGrid images={selected.extraImages || []} editable onRemove={removeExtraImage} onPreview={setPreviewImage} />
                <button onClick={saveAllSettings} style={primaryButton()}>儲存到雲端</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 21, fontWeight: 900 }}>{selected.name || "未命名GK"}</div>
                <div style={{ color: "#c9ced7", fontSize: 15 }}>{selected.studio || "未填寫工作室"}</div>
                <div style={{ color: "#6b7280", fontSize: 13 }}>{selected.location}</div>
                {selected.ownerName && <div style={{ color: "#9ca3af", fontSize: 13 }}>來源：{selected.ownerName} / {selected.roomName}</div>}
                <div style={{ color: "#fda4af", fontSize: 13, fontWeight: 800 }}>⭐ 收藏 {favoriteCount}　❤️ 讚 {likeCount}　💬 留言 {commentCount}</div>
                <div style={sectionTitle()}>細節圖片</div>
                {(selected.extraImages || []).length ? <DetailGrid images={[selected.image, ...(selected.extraImages || [])]} onPreview={setPreviewImage} /> : <div style={{ color: "#6b7280", fontSize: 13, lineHeight: 1.7 }}>尚未上傳細節圖片</div>}
                {readOnly && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <button onClick={() => toggleLike?.(selected)} style={{ ...primaryButton(), background: isLiked ? "#be123c" : "#374151" }}>{isLiked ? "❤️ 已讚" : "♡ 讚"}</button>
                  <button onClick={() => toggleFavorite(selected)} style={{ ...primaryButton(), background: isFavorite ? "#7c3aed" : "#2563eb" }}>{isFavorite ? "⭐ 已收藏" : "☆ 收藏"}</button>
                </div>}
                {readOnly && <CommentBox comments={comments} commentInput={commentInput} setCommentInput={setCommentInput} onSubmit={() => addComment?.(selected)} />}
                {!readOnly && <button onClick={() => setIsEditingMeta(true)} style={secondaryButton()}>重新編輯資料 / 位置</button>}
                {!readOnly && <button onClick={deleteSelectedItem} style={dangerButton()}>刪除此 GK</button>}
              </>
            )}
          </div>
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#777", textAlign: "center", lineHeight: 1.8 }}>{mode === "explore" ? "選擇一個公開展櫃" : mode === "favorites" ? "收藏的 GK 會顯示在左側" : "點選層架上的 GK\n可查看資料與細節圖"}</div>
        )}
      </div>
    </aside>
  );
}

function CommentBox({ comments = [], commentInput = "", setCommentInput, onSubmit }) {
  return (
    <div style={{ borderTop: "1px solid #1f2937", paddingTop: 12, display: "grid", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 900, color: "#e5e7eb" }}>留言</div>
      <div style={{ display: "grid", gap: 8, maxHeight: 180, overflowY: "auto" }}>
        {comments.length ? comments.map((comment) => (
          <div key={comment.id} style={{ border: "1px solid #1f2937", background: "#080b10", borderRadius: 12, padding: 10 }}>
            <div style={{ color: "#cbd5e1", fontSize: 12, fontWeight: 800 }}>{comment.profiles?.username || "GK玩家"}</div>
            <div style={{ color: "#e5e7eb", fontSize: 13, marginTop: 5, lineHeight: 1.5 }}>{comment.body}</div>
          </div>
        )) : <div style={{ color: "#6b7280", fontSize: 13 }}>還沒有留言。</div>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 72px", gap: 8 }}>
        <input value={commentInput} onChange={(e) => setCommentInput?.(e.target.value)} placeholder="寫留言..." style={textInputStyle()} data-no-drag="true" />
        <button onClick={onSubmit} style={secondaryButton()}>送出</button>
      </div>
    </div>
  );
}

function DetailGrid({ images, editable = false, onRemove, onPreview }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {images.map((img, index) => (
        <button key={index} onClick={() => onPreview(images, index)} style={{ position: "relative", padding: 0, border: "1px solid #1f2937", borderRadius: 12, overflow: "hidden", background: "#11141a", cursor: "pointer" }}>
          <img src={img} loading="lazy" decoding="async" alt={`detail-${index}`} style={{ width: "100%", height: 102, objectFit: "cover", display: "block" }} />
          {editable && <span onClick={(e) => { e.stopPropagation(); onRemove(index); }} style={smallRemoveButton()}>×</span>}
        </button>
      ))}
    </div>
  );
}

function ImageModal({ src, total = 1, index = 0, onClose, onPrev, onNext }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.86)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 28, boxSizing: "border-box", cursor: "zoom-out" }}>
      <img src={src} loading="lazy" decoding="async" alt="detail preview" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "88vw", maxHeight: "88vh", objectFit: "contain", borderRadius: 16, background: "#11141a", boxShadow: "0 30px 100px rgba(0,0,0,0.65)" }} />
      {total > 1 && (
        <>
          <button onClick={(e) => { e.stopPropagation(); onPrev(); }} style={modalArrowButton("left")}>‹</button>
          <button onClick={(e) => { e.stopPropagation(); onNext(); }} style={modalArrowButton("right")}>›</button>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", color: "white", background: "rgba(0,0,0,0.48)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 999, padding: "8px 14px", fontSize: 13 }}>{index + 1} / {total}</div>
        </>
      )}
      <button onClick={onClose} style={{ position: "fixed", top: 24, right: 24, width: 42, height: 42, borderRadius: 999, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.5)", color: "white", fontSize: 24, cursor: "pointer" }}>×</button>
    </div>
  );
}

function isMobileDevice() {
  if (typeof window === "undefined") return false;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
  const touchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  return window.innerWidth <= 768 || (touchDevice && coarsePointer);
}
function countItems(rack) { return rack.flat().filter(Boolean).length; }
function slotStyle(locked) { return { width: "100%", height: "100%", border: `1px dashed ${locked ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.16)"}`, background: locked ? "rgba(255,255,255,0.012)" : "rgba(255,255,255,0.025)", borderRadius: 8, cursor: locked ? "default" : "pointer" }; }
function leftAsideStyle() { return { width: 198, borderRight: "1px solid #171b22", padding: "24px 14px", background: "#04070b", boxSizing: "border-box", flexShrink: 0, overflowY: "auto" }; }
function rightAsideStyle() { return { width: 350, borderLeft: "1px solid #171b22", padding: 16, boxSizing: "border-box", background: "#04070b", flexShrink: 0, display: "flex", flexDirection: "column", gap: 14 }; }
function mainStyle() { return { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "14px 18px", boxSizing: "border-box", overflow: "hidden" }; }
function navButton(active) { return { height: 38, borderRadius: 12, border: "1px solid #171b22", background: active ? "#111827" : "transparent", color: active ? "white" : "#9ca3af", textAlign: "left", padding: "0 12px", cursor: "pointer" }; }
function panelBox() { return { border: "1px solid #171b22", background: "#080b10", borderRadius: 16, padding: 12, boxSizing: "border-box" }; }
function primaryButton() { return { height: 42, borderRadius: 12, border: "1px solid rgba(255,255,255,0.14)", background: "#2563eb", color: "white", fontWeight: 800, cursor: "pointer" }; }
function secondaryButton() { return { height: 38, borderRadius: 12, border: "1px solid #2a2e36", background: "#161a22", color: "white", cursor: "pointer" }; }
function dangerButton() { return { height: 36, width: "100%", borderRadius: 12, border: "1px solid rgba(239,68,68,0.35)", background: "rgba(127,29,29,0.25)", color: "#fecaca", cursor: "pointer" }; }
function cabinetMiniButton() { return { width: 26, height: 26, borderRadius: 8, border: "1px solid #2a2e36", background: "#111827", color: "white", fontWeight: 900, cursor: "pointer", lineHeight: "20px" }; }
function textInputStyle() { return { width: "100%", height: 42, borderRadius: 12, border: "1px solid #232833", background: "#11141a", color: "white", padding: "0 12px", boxSizing: "border-box", outline: "none" }; }
function smallRemoveButton() { return { position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 999, border: "1px solid rgba(255,255,255,0.22)", background: "rgba(0,0,0,0.58)", color: "white", cursor: "pointer", lineHeight: "20px" }; }
function sectionTitle() { return { marginTop: 8, paddingTop: 12, borderTop: "1px solid #1f2937", color: "#e5e7eb", fontSize: 13, fontWeight: 800 }; }
function emptyTextStyle() { return { border: "1px solid #171b22", background: "#0a0d12", borderRadius: 18, padding: 28, color: "#9ca3af" }; }
function roomCardStyle() { return { textAlign: "left", border: "1px solid #1f2937", background: "linear-gradient(135deg, #0b0f15, #111827)", borderRadius: 18, padding: 18, color: "white", cursor: "pointer", minHeight: 150 }; }
function publicBadgeStyle() { return { position: "absolute", top: 14, left: 14, zIndex: 20, background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 999, padding: "8px 12px", fontSize: 13, fontWeight: 800 }; }
function detailBoxStyle() { return { flex: 1, borderRadius: 18, border: "1px solid #171b22", background: "#0a0d12", padding: 14, boxSizing: "border-box", overflowY: "auto", whiteSpace: "pre-line" }; }
function modalArrowButton(side) { return { position: "fixed", top: "50%", [side]: 26, transform: "translateY(-50%)", width: 54, height: 72, borderRadius: 18, border: "1px solid rgba(255,255,255,0.22)", background: "rgba(0,0,0,0.48)", color: "white", fontSize: 46, lineHeight: "62px", cursor: "pointer" }; }
