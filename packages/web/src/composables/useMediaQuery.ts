import { onMounted, onUnmounted, type Ref, ref } from "vue";

/** Tailwind `lg` = 1024px */
export const LG_QUERY = "(min-width: 1024px)";

export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(typeof window !== "undefined" ? window.matchMedia(query).matches : false);
  let mql: MediaQueryList | null = null;

  function onChange() {
    matches.value = !!mql?.matches;
  }

  onMounted(() => {
    mql = window.matchMedia(query);
    onChange();
    mql.addEventListener("change", onChange);
  });

  onUnmounted(() => {
    mql?.removeEventListener("change", onChange);
  });

  return matches;
}
