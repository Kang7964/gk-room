import React, { useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

const DOUBLE_RACK_IMAGE = "/double-rack-ui.png";
const STORAGE_BUCKET = "gk-images";
const RACK_ASPECT = 1536 / 1024;
const STORAGE_KEY = "gk-room-rack-v2";

const LEFT_COLUMNS = [19.8, 31.1, 42.4];
const RIGHT_COLUMNS = [57.8, 69.1, 80.4];
const ALL_COLUMNS = [...LEFT_COLUMNS, ...RIGHT_COLUMNS];
const SHELF_ANCHORS_Y = [44.2, 69.2, 94.0];
const SLOT_BOX = { width: 10.4, height: 18 };
const EMPTY_RACK = [
  [null, null, null, null, null, null],
  [null, null, null, null, null, null],
  [null, null, null, null, null, null],
];

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

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "image/png";
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
  const ext = isDataUrl ? "png" : (file?.name?.split(".").pop() || "png").toLowerCase();
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
  const scale = item.scale ?? 1;
  const offsetX = item.offsetX ?? 0;
  const offsetY = item.offsetY ?? 0;

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    setTilt({ rx: (0.5 - py) * 10, ry: (px - 0.5) * 14 });
  }

  return (
    <div onClick={onSelect} onMouseMove={handleMove} onMouseLeave={() => setTilt({ rx: 0, ry: 0 })} style={{ position: "relative", width: "100%", height: "100%", overflow: "visible", cursor: "pointer", perspective: "1000px", transformStyle: "preserve-3d" }} title={readOnly ? "查看 GK" : "編輯 GK"}>
      <img
        src={item.image}
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
          transition: "transform 120ms ease",
          transformOrigin: "bottom center",
          pointerEvents: "none",
        }}
      />
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
  const [roomSettings, setRoomSettings] = useState({ id: null, public_left: true, public_right: false });
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
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const fileInputRef = useRef(null);
  const uploadTargetRef = useRef(null);
  const extraInputRef = useRef(null);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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
    } else {
      setRack(cloneEmptyRack());
      setSelected(null);
      setFavorites([]);
      setFavoriteIds(new Set());
    }
  }, [user]);

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
        public_right: false,
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
    const { data: existing, error } = await supabase.from("gk_rooms").select("id, public_left, public_right, room_name").eq("user_id", userId).maybeSingle();
    if (error) {
      console.error(error);
      return null;
    }
    if (existing) {
      setRoomSettings({ id: existing.id, public_left: existing.public_left ?? true, public_right: existing.public_right ?? false });
      return existing;
    }

    const defaultName = profileName || user?.email?.split("@")[0] || "GK玩家";
    const { data: created, error: createError } = await supabase.from("gk_rooms").insert({ user_id: userId, room_name: `${defaultName} 的 GK ROOM`, is_public: true, public_left: true, public_right: false }).select("id, public_left, public_right, room_name").single();
    if (createError) {
      console.error(createError);
      return null;
    }
    setRoomSettings({ id: created.id, public_left: created.public_left, public_right: created.public_right });
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
      if (row.shelf_index >= 0 && row.shelf_index < 3 && row.slot_index >= 0 && row.slot_index < 6) {
        next[row.shelf_index][row.slot_index] = dbToItem(row);
      }
    });
    return next;
  }

  async function updateCabinetPrivacy(side, value) {
    if (!user) return;
    const field = side === "left" ? "public_left" : "public_right";
    const next = { ...roomSettings, [field]: value };
    setRoomSettings(next);

    const { error } = await supabase.from("gk_rooms").update({ [field]: value, is_public: next.public_left || next.public_right, updated_at: new Date().toISOString() }).eq("user_id", user.id);
    if (error) {
      console.error(error);
      setSyncMessage("公開設定儲存失敗");
    } else {
      setSyncMessage("公開設定已儲存");
    }
  }

  async function loadPublicRooms() {
    setMode("explore");
    setViewingRoom(null);
    setPublicSelected(null);
    setPublicLoading(true);
    const { data, error } = await supabase.from("gk_rooms").select("id,user_id,room_name,is_public,public_left,public_right,updated_at,created_at,profiles(username)").eq("is_public", true).order("updated_at", { ascending: false });
    if (error) console.error(error);

    const unique = [];
    const seen = new Set();
    for (const room of data || []) {
      if (seen.has(room.user_id)) continue;
      if (!(room.public_left || room.public_right)) continue;
      seen.add(room.user_id);
      unique.push(room);
    }
    setPublicRooms(unique);
    setPublicLoading(false);
  }

  async function openPublicRoom(room) {
    setViewingRoom(room);
    setPublicSelected(null);
    setPublicLoading(true);

    const { data, error } = await supabase.from("gk_items").select("*").eq("user_id", room.user_id).order("shelf_index", { ascending: true }).order("slot_index", { ascending: true });
    if (error) console.error(error);

    const visibleRows = (data || []).filter((row) => {
      if (row.slot_index >= 0 && row.slot_index <= 2) return room.public_left;
      if (row.slot_index >= 3 && row.slot_index <= 5) return room.public_right;
      return false;
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
    return `${slotIndex <= 2 ? "左櫃" : "右櫃"} / 第 ${shelfIndex + 1} 層 / 第 ${(slotIndex % 3) + 1} 格`;
  }

  function selectItem(item, shelfIndex, slotIndex) {
    setSelected({ ...item, location: cabinetLocation(shelfIndex, slotIndex), shelfIndex, slotIndex });
    setIsEditingMeta(!item.isSaved);
    setHighlight(item.id);
    setTimeout(() => setHighlight(null), 1600);
  }

  function selectPublicItem(item, shelfIndex, slotIndex) {
    setPublicSelected({ ...item, location: cabinetLocation(shelfIndex, slotIndex), shelfIndex, slotIndex });
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
        const url = await uploadImageToStorage({ file, userId: user.id, folder: "details" });
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
  const activeSelected = mode === "publicRoom" ? publicSelected : selected;
  const readOnly = mode === "publicRoom";

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
        previewIndex={previewIndex}
        previewImages={previewImages}
        closeImagePreview={closeImagePreview}
        showPrevImage={showPrevImage}
        showNextImage={showNextImage}
      />
    );
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "#07090d", color: "white", overflow: "hidden", fontFamily: "Arial, sans-serif" }}>
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUpload} style={{ display: "none" }} />
      <input ref={extraInputRef} type="file" accept="image/*" multiple onChange={handleExtraUpload} style={{ display: "none" }} />

      <aside style={leftAsideStyle()}>
        <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.15, marginBottom: 6, letterSpacing: 0.4 }}>GK<br />ROOM</div>
        <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 22 }}>{profileName}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          <button onClick={() => { setMode("mine"); setViewingRoom(null); }} style={navButton(mode === "mine")}>我的展示間</button>
          <button onClick={loadFavorites} style={navButton(mode === "favorites")}>收藏管理</button>
          <button onClick={loadPublicRooms} style={navButton(mode === "explore" || mode === "publicRoom")}>公開展櫃</button>
        </div>

        {mode === "mine" && (
          <>
            <div style={panelBox()}>
              <div style={{ fontSize: 13, color: "#e5e7eb", marginBottom: 10, fontWeight: 800 }}>展示名稱</div>
              <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="輸入你的展示名稱" style={{ ...textInputStyle(), height: 36, marginBottom: 10 }} />
              <button onClick={saveProfileName} style={{ ...secondaryButton(), width: "100%" }}>儲存名稱</button>
            </div>

            <div style={{ ...panelBox(), marginTop: 12 }}>
              <div style={{ fontSize: 13, color: "#e5e7eb", marginBottom: 10, fontWeight: 800 }}>櫃體公開設定</div>
              <PrivacyToggle label="左櫃公開" checked={roomSettings.public_left} onChange={(v) => updateCabinetPrivacy("left", v)} />
              <PrivacyToggle label="右櫃公開" checked={roomSettings.public_right} onChange={(v) => updateCabinetPrivacy("right", v)} />
              <div style={{ color: "#6b7280", fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>自己永遠看得到兩櫃；別人只看得到你公開的櫃。</div>
            </div>

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
          </>
        )}

        {mode === "mine" && <button onClick={() => loadCloudRack(user.id)} style={{ ...secondaryButton(), width: "100%", marginTop: 12 }}>重新同步雲端</button>}
        {mode === "mine" && <button onClick={resetAllData} style={{ ...dangerButton(), marginTop: 10 }}>清空雲端資料</button>}
        {mode === "publicRoom" && <button onClick={loadPublicRooms} style={{ ...secondaryButton(), width: "100%", marginTop: 12 }}>返回公開展櫃</button>}
        <button onClick={logout} style={{ ...secondaryButton(), width: "100%", marginTop: 10 }}>登出</button>
      </aside>

      {mode === "explore" ? (
        <ExploreView loading={publicLoading} rooms={publicRooms} onOpen={openPublicRoom} />
      ) : mode === "favorites" ? (
        <FavoritesView favorites={favorites} onOpenPreview={openImagePreview} onRemoveFavorite={toggleFavorite} />
      ) : (
        <ShowroomView rack={activeRack} readOnly={readOnly} highlight={highlight} onSlotClick={openUpload} onSelectItem={readOnly ? selectPublicItem : selectItem} viewingRoom={viewingRoom} />
      )}

      <RightPanel
        mode={mode}
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
        toggleFavorite={toggleFavorite}
      />

      {previewIndex !== null && previewImages[previewIndex] && (
        <ImageModal src={previewImages[previewIndex]} total={previewImages.length} index={previewIndex} onClose={closeImagePreview} onPrev={showPrevImage} onNext={showNextImage} />
      )}
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
  previewIndex,
  previewImages,
  closeImagePreview,
  showPrevImage,
  showNextImage,
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
      </div>

      {mode === "mine" && (
        <div style={{ padding: 12, display: "grid", gap: 12 }}>
          <div style={panelBox()}>
            <div style={{ fontSize: 13, color: "#e5e7eb", marginBottom: 10, fontWeight: 800 }}>展示名稱</div>
            <input value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="輸入你的展示名稱" style={{ ...textInputStyle(), height: 38, marginBottom: 10 }} />
            <button onClick={saveProfileName} style={{ ...secondaryButton(), width: "100%" }}>儲存名稱</button>
          </div>
          <div style={panelBox()}>
            <div style={{ fontSize: 13, color: "#e5e7eb", marginBottom: 10, fontWeight: 800 }}>櫃體公開設定</div>
            <PrivacyToggle label="左櫃公開" checked={roomSettings.public_left} onChange={(v) => updateCabinetPrivacy("left", v)} />
            <PrivacyToggle label="右櫃公開" checked={roomSettings.public_right} onChange={(v) => updateCabinetPrivacy("right", v)} />
          </div>
          <div style={panelBox()}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 10, color: "#cbd5e1" }}>
              <input type="checkbox" checked={useFreeRemoveBg} onChange={(e) => toggleFreeRemoveBg(e.target.checked)} />上傳時自動去背
            </label>
            <RangeControl label="去背強度" value={bgTolerance} min={35} max={130} step={1} onChange={updateTolerance} />
            {processMessage && <div style={{ color: processing ? "#93c5fd" : "#9ca3af", fontSize: 12, lineHeight: 1.5, marginTop: 10 }}>{processMessage}</div>}
            {syncMessage && <div style={{ color: "#86efac", fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>{syncMessage}</div>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={loadCloudRack} style={secondaryButton()}>重新同步</button>
            <button onClick={resetAllData} style={dangerButton()}>清空資料</button>
          </div>
        </div>
      )}

      {mode === "explore" ? (
        <ExploreView loading={publicLoading} rooms={publicRooms} onOpen={openPublicRoom} />
      ) : mode === "favorites" ? (
        <FavoritesView favorites={favorites} onOpenPreview={openImagePreview} onRemoveFavorite={toggleFavorite} />
      ) : (
        <MobileRackView rack={activeRack} readOnly={readOnly} highlight={highlight} onSlotClick={openUpload} onSelectItem={selectItem} viewingRoom={viewingRoom} />
      )}

      {mode !== "explore" && mode !== "favorites" && activeSelected && (
        <MobileDetailSheet
          selected={activeSelected}
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
          toggleFavorite={toggleFavorite}
        />
      )}

      {previewIndex !== null && previewImages[previewIndex] && (
        <ImageModal src={previewImages[previewIndex]} total={previewImages.length} index={previewIndex} onClose={closeImagePreview} onPrev={showPrevImage} onNext={showNextImage} />
      )}
    </div>
  );
}

function MobileRackView({ rack, readOnly, highlight, onSlotClick, onSelectItem, viewingRoom }) {
  return (
    <main style={{ padding: "12px 12px 220px", boxSizing: "border-box" }}>
      {viewingRoom && <div style={{ ...panelBox(), marginBottom: 12, fontWeight: 800 }}>{viewingRoom.room_name || "公開展示櫃"}</div>}
      {rack.map((row, shelfIndex) => (
        <div key={`mobile-shelf-${shelfIndex}`} style={{ marginBottom: 18 }}>
          <div style={{ color: "#9ca3af", fontSize: 13, fontWeight: 800, margin: "0 0 8px 2px" }}>第 {shelfIndex + 1} 層</div>
          <MobileCabinetRow title="左櫃" row={row} start={0} shelfIndex={shelfIndex} readOnly={readOnly} highlight={highlight} onSlotClick={onSlotClick} onSelectItem={onSelectItem} />
          <MobileCabinetRow title="右櫃" row={row} start={3} shelfIndex={shelfIndex} readOnly={readOnly} highlight={highlight} onSlotClick={onSlotClick} onSelectItem={onSelectItem} />
        </div>
      ))}
    </main>
  );
}

function MobileCabinetRow({ title, row, start, shelfIndex, readOnly, highlight, onSlotClick, onSelectItem }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#cbd5e1", fontSize: 12, marginBottom: 6 }}>
        <span style={{ width: 5, height: 5, borderRadius: 999, background: "#6366f1" }} />{title}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {[0, 1, 2].map((i) => {
          const slotIndex = start + i;
          const item = row[slotIndex];
          const highlighted = item && highlight === item.id;
          return (
            <div key={`mobile-${shelfIndex}-${slotIndex}`} style={{ height: 154, borderRadius: 14, border: "1px solid #1f2937", background: "linear-gradient(180deg, #111827, #080b10)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", left: 8, right: 8, bottom: 16, height: 8, borderRadius: 999, background: "rgba(255,255,255,0.12)" }} />
              {item ? (
                <GKStand item={item} highlighted={highlighted} readOnly={readOnly} onSelect={() => onSelectItem(item, shelfIndex, slotIndex)} />
              ) : readOnly ? (
                <SlotBase locked />
              ) : (
                <button onClick={() => onSlotClick(shelfIndex, slotIndex)} style={{ width: "100%", height: "100%", border: "1px dashed rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.025)", color: "#6b7280", borderRadius: 14 }}>＋</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MobileDetailSheet({ selected, readOnly, isEditingMeta, setIsEditingMeta, updateSelectedField, saveAllSettings, deleteSelectedItem, extraInputRef, removeExtraImage, setPreviewImage, isFavorite, toggleFavorite }) {
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 60, background: "rgba(4,7,11,0.98)", borderTop: "1px solid #1f2937", borderRadius: "22px 22px 0 0", padding: 14, maxHeight: "58vh", overflowY: "auto", boxShadow: "0 -20px 70px rgba(0,0,0,0.55)" }}>
      <div style={{ width: 44, height: 4, borderRadius: 999, background: "#374151", margin: "0 auto 12px" }} />
      <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <img src={selected.image} alt={selected.name || "GK"} style={{ width: 88, height: 88, objectFit: "contain", borderRadius: 12, background: "#11141a" }} />
        <div>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{selected.name || "未命名GK"}</div>
          <div style={{ color: "#cbd5e1", fontSize: 13, marginTop: 4 }}>{selected.studio || "未填寫工作室"}</div>
          <div style={{ color: "#6b7280", fontSize: 12, marginTop: 4 }}>{selected.location}</div>
        </div>
      </div>
      {!readOnly && isEditingMeta ? (
        <div style={{ display: "grid", gap: 10 }}>
          <TextInput value={selected.name || ""} onChange={(e) => updateSelectedField("name", e.target.value)} placeholder="請填寫 GK 名稱" />
          <TextInput value={selected.studio || ""} onChange={(e) => updateSelectedField("studio", e.target.value)} placeholder="請填寫工作室名稱" />
          <RangeControl label="大小" value={selected.scale ?? 1} min={0.6} max={1.6} step={0.01} onChange={(v) => updateSelectedField("scale", v)} />
          <RangeControl label="左右" value={selected.offsetX ?? 0} min={-40} max={40} step={1} onChange={(v) => updateSelectedField("offsetX", v)} />
          <RangeControl label="上下" value={selected.offsetY ?? 0} min={-40} max={40} step={1} onChange={(v) => updateSelectedField("offsetY", v)} />
          <button onClick={() => extraInputRef.current?.click()} style={secondaryButton()}>上傳細節圖片</button>
          <DetailGrid images={selected.extraImages || []} editable onRemove={removeExtraImage} onPreview={setPreviewImage} />
          <button onClick={saveAllSettings} style={primaryButton()}>儲存到雲端</button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {(selected.extraImages || []).length ? <DetailGrid images={selected.extraImages || []} onPreview={setPreviewImage} /> : <div style={{ color: "#6b7280", fontSize: 13 }}>尚未上傳細節圖片</div>}
          {readOnly && <button onClick={() => toggleFavorite(selected)} style={{ ...primaryButton(), background: isFavorite ? "#be123c" : "#2563eb" }}>{isFavorite ? "❤️ 已收藏 / 點擊取消" : "♡ 收藏這隻 GK"}</button>}
          {!readOnly && <button onClick={() => setIsEditingMeta(true)} style={secondaryButton()}>重新編輯資料 / 位置</button>}
          {!readOnly && <button onClick={deleteSelectedItem} style={dangerButton()}>刪除此 GK</button>}
        </div>
      )}
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

function ShowroomView({ rack, readOnly, highlight, onSlotClick, onSelectItem, viewingRoom }) {
  return (
    <main style={mainStyle()}>
      <div style={{ position: "relative", width: "min(1360px, 72vw)", aspectRatio: `${RACK_ASPECT}`, maxHeight: "76vh", backgroundImage: `url(${DOUBLE_RACK_IMAGE})`, backgroundRepeat: "no-repeat", backgroundPosition: "center", backgroundSize: "100% 100%", borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.32)" }}>
        {viewingRoom && <div style={publicBadgeStyle()}>{viewingRoom.room_name || "公開展示櫃"}</div>}
        {rack.map((row, shelfIndex) =>
          row.map((item, slotIndex) => {
            const point = ANCHORS[shelfIndex][slotIndex];
            const highlighted = item && highlight === item.id;
            return (
              <div key={`slot-${shelfIndex}-${slotIndex}`} style={{ position: "absolute", left: `${point.x}%`, top: `${point.y}%`, transform: "translate(-50%, -100%)", width: `${SLOT_BOX.width}%`, height: `${SLOT_BOX.height}%` }}>
                {item ? <GKStand item={item} highlighted={highlighted} readOnly={readOnly} onSelect={() => onSelectItem(item, shelfIndex, slotIndex)} /> : readOnly ? <SlotBase locked /> : <SlotBase onClick={() => onSlotClick(shelfIndex, slotIndex)} />}
              </div>
            );
          })
        )}
      </div>
    </main>
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
                <div style={{ height: 110, borderRadius: 14, border: "1px solid #1f2937", background: "radial-gradient(circle at top, #1e293b, #07090d 70%)", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "center", color: "#818cf8", fontSize: 34, fontWeight: 900 }}>GK</div>
                <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 8 }}>{room.room_name || `${room.profiles?.username || "GK玩家"} 的 GK ROOM`}</div>
                <div style={{ color: "#9ca3af", fontSize: 13 }}>By {room.profiles?.username || "GK玩家"}</div>
                <div style={{ color: "#9ca3af", fontSize: 13, marginTop: 8 }}>公開範圍：{room.public_left ? "左櫃 " : ""}{room.public_right ? "右櫃" : ""}</div>
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
                  <img src={fav.item.image} alt={fav.item.name} style={{ width: "100%", height: 160, objectFit: "contain", display: "block" }} />
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

function RightPanel({ mode, selected, isEditingMeta, setIsEditingMeta, updateSelectedField, saveAllSettings, deleteSelectedItem, extraInputRef, removeExtraImage, setPreviewImage, rack, readOnly, viewingRoom, isFavorite, toggleFavorite }) {
  return (
    <aside style={rightAsideStyle()}>
      <div style={{ height: 84, borderRadius: 16, background: "linear-gradient(135deg, #111827, #0b0f15)", border: "1px solid #171b22", padding: 14, boxSizing: "border-box" }}>
        <div style={{ fontSize: 14, color: "#9ca3af" }}>{mode === "publicRoom" ? "正在瀏覽" : mode === "favorites" ? "收藏數量" : "收藏狀態"}</div>
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>{mode === "publicRoom" ? (viewingRoom?.room_name || "公開展示櫃") : `${countItems(rack)} / 18`}</div>
      </div>
      <div style={{ fontSize: 16, fontWeight: 800 }}>{readOnly ? "GK資訊" : "展示GK"}</div>
      <div style={detailBoxStyle()}>
        {selected ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <img src={selected.image} alt={selected.name || "GK"} style={{ width: "100%", height: 210, objectFit: "contain", borderRadius: 14, background: "#11141a" }} />
            {!readOnly && isEditingMeta ? (
              <>
                <TextInput value={selected.name || ""} onChange={(e) => updateSelectedField("name", e.target.value)} placeholder="請填寫 GK 名稱" />
                <TextInput value={selected.studio || ""} onChange={(e) => updateSelectedField("studio", e.target.value)} placeholder="請填寫工作室名稱" />
                <div style={sectionTitle()}>位置校正</div>
                <RangeControl label="大小" value={selected.scale ?? 1} min={0.6} max={1.6} step={0.01} onChange={(v) => updateSelectedField("scale", v)} />
                <RangeControl label="左右" value={selected.offsetX ?? 0} min={-40} max={40} step={1} onChange={(v) => updateSelectedField("offsetX", v)} />
                <RangeControl label="上下" value={selected.offsetY ?? 0} min={-40} max={40} step={1} onChange={(v) => updateSelectedField("offsetY", v)} />
                <div style={sectionTitle()}>細節圖片 {selected.extraImages?.length || 0} / 5</div>
                <button onClick={() => extraInputRef.current?.click()} style={secondaryButton()}>上傳細節圖片</button>
                <DetailGrid images={selected.extraImages || []} editable onRemove={removeExtraImage} onPreview={setPreviewImage} />
                <button onClick={saveAllSettings} style={primaryButton()}>儲存到雲端</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 21, fontWeight: 900 }}>{selected.name || "未命名GK"}</div>
                <div style={{ color: "#c9ced7", fontSize: 15 }}>{selected.studio || "未填寫工作室"}</div>
                <div style={{ color: "#6b7280", fontSize: 13 }}>{selected.location}</div>
                <div style={sectionTitle()}>細節圖片</div>
                {(selected.extraImages || []).length ? <DetailGrid images={selected.extraImages || []} onPreview={setPreviewImage} /> : <div style={{ color: "#6b7280", fontSize: 13, lineHeight: 1.7 }}>尚未上傳細節圖片</div>}
                {readOnly && <button onClick={() => toggleFavorite(selected)} style={{ ...primaryButton(), background: isFavorite ? "#be123c" : "#2563eb" }}>{isFavorite ? "❤️ 已收藏 / 點擊取消" : "♡ 收藏這隻 GK"}</button>}
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

function DetailGrid({ images, editable = false, onRemove, onPreview }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {images.map((img, index) => (
        <button key={index} onClick={() => onPreview(images, index)} style={{ position: "relative", padding: 0, border: "1px solid #1f2937", borderRadius: 12, overflow: "hidden", background: "#11141a", cursor: "pointer" }}>
          <img src={img} alt={`detail-${index}`} style={{ width: "100%", height: 102, objectFit: "cover", display: "block" }} />
          {editable && <span onClick={(e) => { e.stopPropagation(); onRemove(index); }} style={smallRemoveButton()}>×</span>}
        </button>
      ))}
    </div>
  );
}

function ImageModal({ src, total = 1, index = 0, onClose, onPrev, onNext }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.86)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 28, boxSizing: "border-box", cursor: "zoom-out" }}>
      <img src={src} alt="detail preview" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "88vw", maxHeight: "88vh", objectFit: "contain", borderRadius: 16, background: "#11141a", boxShadow: "0 30px 100px rgba(0,0,0,0.65)" }} />
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
function textInputStyle() { return { width: "100%", height: 42, borderRadius: 12, border: "1px solid #232833", background: "#11141a", color: "white", padding: "0 12px", boxSizing: "border-box", outline: "none" }; }
function smallRemoveButton() { return { position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: 999, border: "1px solid rgba(255,255,255,0.22)", background: "rgba(0,0,0,0.58)", color: "white", cursor: "pointer", lineHeight: "20px" }; }
function sectionTitle() { return { marginTop: 8, paddingTop: 12, borderTop: "1px solid #1f2937", color: "#e5e7eb", fontSize: 13, fontWeight: 800 }; }
function emptyTextStyle() { return { border: "1px solid #171b22", background: "#0a0d12", borderRadius: 18, padding: 28, color: "#9ca3af" }; }
function roomCardStyle() { return { textAlign: "left", border: "1px solid #1f2937", background: "linear-gradient(135deg, #0b0f15, #111827)", borderRadius: 18, padding: 18, color: "white", cursor: "pointer", minHeight: 150 }; }
function publicBadgeStyle() { return { position: "absolute", top: 14, left: 14, zIndex: 20, background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 999, padding: "8px 12px", fontSize: 13, fontWeight: 800 }; }
function detailBoxStyle() { return { flex: 1, borderRadius: 18, border: "1px solid #171b22", background: "#0a0d12", padding: 14, boxSizing: "border-box", overflowY: "auto", whiteSpace: "pre-line" }; }
function modalArrowButton(side) { return { position: "fixed", top: "50%", [side]: 26, transform: "translateY(-50%)", width: 54, height: 72, borderRadius: 18, border: "1px solid rgba(255,255,255,0.22)", background: "rgba(0,0,0,0.48)", color: "white", fontSize: 46, lineHeight: "62px", cursor: "pointer" }; }
