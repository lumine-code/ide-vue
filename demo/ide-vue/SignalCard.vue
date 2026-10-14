<script setup lang="ts">
const samples = [0.2, 0.8, -0.4, 0.5, 1.0];
const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;

const amplitude: number = "high";
</script>

<template>
  <article>
    <h2>Signal Lab</h2>
    <p>Mean amplitude: {{ average }}</p>
    <p>Level: {{ amplitude }}</p>
  </article>
</template>

<style scoped>
article {
  colour: #bd881f;
  padding: 24px;
}
</style>
