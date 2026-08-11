<script setup lang="ts">
import { computed, ref } from "vue";
import ChildCard from "./ChildCard.vue";

const count = ref(1);
const doubled = computed(() => count.value * 2);
const label: string = 42;

function increment(step: number) {
  count.value += step;
}
</script>

<template>
  <main>
    <ChildCard  :title="label" @select="increment" />
    <button @click="increment('bad')">{{ doubled }}</button>
    <div v-if="count > 0" class="active">{{ label }}</div>
  </main>
</template>

<style scoped>
.active{--accent:#ff0000;color:var(--accent)}
.broken { color: ; }
</style>
