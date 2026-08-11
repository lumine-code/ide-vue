<script setup lang="ts">
defineProps<{ title: string; count: number }>();
const emit = defineEmits<{ select: [step: number] }>();
</script>

<template>
  <article class="card" @click="emit('select', 1)">
    <h2>{{ title }}</h2>
    <span>{{ count }}</span>
  </article>
</template>

<style scoped>
.card {
  padding: 1rem;
}
</style>
