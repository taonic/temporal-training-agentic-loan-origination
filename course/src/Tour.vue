<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

// A lightweight, dependency-free product tour. Each step points at a DOM element
// by CSS selector; the overlay dims the page, spotlights that element, and shows
// a tooltip card with prev/next controls. Steps whose target isn't on the page
// right now (e.g. the solution toggle on exercises without a solution) are
// skipped automatically, so the same step list works on every exercise.
const props = defineProps({
  steps: { type: Array, required: true },
});
const emit = defineEmits(["finish"]);

const PAD = 8; // breathing room around the spotlighted element
const GAP = 14; // distance between the spotlight and the tooltip card

const rawIndex = ref(0);
const rect = ref(null);
const tooltipRef = ref(null);
const tipPos = ref({ top: 0, left: 0, placement: "bottom" });

function resolve(step) {
  return step?.selector ? document.querySelector(step.selector) : null;
}

// The visible steps are those whose target currently exists. We keep the full
// list for indexing but navigation only ever lands on a resolvable step.
const visibleSteps = computed(() => props.steps.filter((step) => !step.selector || resolve(step)));
const total = computed(() => visibleSteps.value.length);
const index = computed(() => Math.min(rawIndex.value, Math.max(0, total.value - 1)));
const step = computed(() => visibleSteps.value[index.value] ?? null);
const isFirst = computed(() => index.value === 0);
const isLast = computed(() => index.value >= total.value - 1);

function measure() {
  const el = resolve(step.value);
  if (!el) {
    rect.value = null;
    return;
  }
  el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  // Let the smooth scroll settle a touch before reading the final position.
  nextTick(() => {
    const r = el.getBoundingClientRect();
    rect.value = { top: r.top, left: r.left, width: r.width, height: r.height };
    placeTooltip();
  });
}

function placeTooltip() {
  const r = rect.value;
  const tip = tooltipRef.value;
  if (!tip) return;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!r) {
    // No target — center the card (used for an intro/welcome step).
    tipPos.value = { top: (vh - th) / 2, left: (vw - tw) / 2, placement: "center" };
    return;
  }

  const below = r.top + r.height + GAP + PAD;
  const above = r.top - GAP - PAD - th;
  let placement = "bottom";
  let top = below;
  if (below + th > vh && above >= 8) {
    placement = "top";
    top = above;
  }
  // Center horizontally on the target, then clamp into the viewport.
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(12, Math.min(left, vw - tw - 12));
  top = Math.max(12, Math.min(top, vh - th - 12));
  tipPos.value = { top, left, placement };
}

const highlightStyle = computed(() => {
  const r = rect.value;
  if (!r) return { display: "none" };
  return {
    top: `${r.top - PAD}px`,
    left: `${r.left - PAD}px`,
    width: `${r.width + PAD * 2}px`,
    height: `${r.height + PAD * 2}px`,
  };
});

const tooltipStyle = computed(() => ({
  top: `${tipPos.value.top}px`,
  left: `${tipPos.value.left}px`,
}));

function next() {
  if (isLast.value) return finish();
  rawIndex.value = index.value + 1;
}
function prev() {
  if (isFirst.value) return;
  rawIndex.value = index.value - 1;
}
function finish() {
  emit("finish");
}

function onKey(event) {
  if (event.key === "Escape") finish();
  else if (event.key === "ArrowRight") next();
  else if (event.key === "ArrowLeft") prev();
}

function onReflow() {
  measure();
}

watch(index, measure);

onMounted(() => {
  nextTick(measure);
  window.addEventListener("resize", onReflow);
  window.addEventListener("scroll", onReflow, true);
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onReflow);
  window.removeEventListener("scroll", onReflow, true);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div v-if="step" class="tour-root" role="dialog" aria-modal="true" aria-label="Product tour">
    <!-- Click-blocking dim layer; clicking it dismisses the tour. -->
    <div class="tour-backdrop" @click="finish" />
    <!-- The spotlight box punches a "hole" via a huge surrounding shadow. -->
    <div v-show="rect" class="tour-spotlight" :style="highlightStyle" />

    <div
      ref="tooltipRef"
      class="tour-tooltip"
      :class="`place-${tipPos.placement}`"
      :style="tooltipStyle"
    >
      <p class="tour-step-count">Step {{ index + 1 }} of {{ total }}</p>
      <h3 class="tour-title">{{ step.title }}</h3>
      <p class="tour-body">{{ step.body }}</p>
      <div class="tour-controls">
        <button class="tour-skip" type="button" @click="finish">Skip tour</button>
        <div class="tour-nav">
          <button v-if="!isFirst" class="button button-secondary" type="button" @click="prev">Back</button>
          <button class="button button-primary" type="button" @click="next">
            {{ isLast ? "Done" : "Next" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
