/**
 * 内置默认头像目录（public/avatars/*.svg，随 dist 由 server 静态托管）。
 * avatar_url 存 "/avatars/<id>.svg" 源相对路径——与上传头像的
 * "/api/attachments/<id>" 同一约定，所有 <img>/<Avatar> 消费方零改动。
 * SVG 为仓库自绘的可信静态资源（无脚本），<img> 内嵌渲染天然不执行脚本。
 */

export const AVATAR_FAMILIES = [
  { key: "orb", label: "渐变" },
  { key: "geo", label: "几何" },
  { key: "pixel", label: "像素" },
  { key: "rings", label: "环纹" },
  { key: "wave", label: "波纹" },
] as const;

export type AvatarFamilyKey = (typeof AVATAR_FAMILIES)[number]["key"];

export interface AvatarPreset {
  id: string;
  label: string;
  family: AvatarFamilyKey;
  url: string;
}

const preset = (id: string, label: string, family: AvatarFamilyKey): AvatarPreset => ({
  id,
  label,
  family,
  url: `/avatars/${id}.svg`,
});

export const DEFAULT_AVATARS: AvatarPreset[] = [
  preset("orb-aurora", "极光", "orb"),
  preset("orb-sunset", "落日", "orb"),
  preset("orb-lagoon", "泻湖", "orb"),
  preset("orb-graphite", "石墨", "orb"),
  preset("geo-citrus", "柑橘", "geo"),
  preset("geo-berry", "浆果", "geo"),
  preset("geo-mint", "薄荷", "geo"),
  preset("geo-quad", "四色", "geo"),
  preset("pixel-violet", "紫像素", "pixel"),
  preset("pixel-ember", "橙像素", "pixel"),
  preset("pixel-matrix", "绿像素", "pixel"),
  preset("rings-ink", "墨蓝", "rings"),
  preset("rings-terra", "陶土", "rings"),
  preset("rings-moss", "苔原", "rings"),
  preset("wave-dusk", "暮色", "wave"),
  preset("wave-sea", "海洋", "wave"),
  preset("wave-mono", "白描", "wave"),
];

export function isPresetAvatarUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.startsWith("/avatars/");
}

/**
 * 无头像时的字母兜底底色：按 name 散列取固定色板，同一名称恒同色。
 * Avatar.vue 与 AvatarPresetPicker 的「字母头像」格共用，保证两处渲染一致。
 * 色板全部为 500/600 档，白字对比安全；字面量类名供 Tailwind content 扫描命中。
 */
const FALLBACK_BG_CLASSES = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-600",
  "bg-lime-600",
  "bg-emerald-600",
  "bg-teal-600",
  "bg-cyan-600",
  "bg-sky-600",
  "bg-indigo-500",
  "bg-violet-600",
  "bg-fuchsia-600",
  "bg-pink-600",
] as const;

export function avatarFallbackClass(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return FALLBACK_BG_CLASSES[h % FALLBACK_BG_CLASSES.length];
}
