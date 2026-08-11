<script setup lang="ts">
import { computed, ref } from "vue";
import ChildCard from "./ChildCard.vue";

const count = ref(1);
const doubled = computed(() => count.value * 2);
const label = "Ready";

function increment(step: number) {
  count.value += step;
}
</script>

<template>
  <main>
    <ChildCard  :title="label" @select="increment" />
    <button @click="increment(1)">{{ doubled }}</button>
    <div v-if="count > 0" class="active">{{ label }}</div>
  </main>
</template>

<style scoped>
.active{--accent:#ff0000;color:var(--accent)}
</style>
