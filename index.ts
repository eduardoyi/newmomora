// Custom entry: background tasks must be defined at module scope before the
// router loads. A headless background launch (WorkManager / BGTaskScheduler)
// evaluates this file but never renders app/_layout.tsx. Imports run in
// order, so the task is defined before the router entry.
import './src/services/widget-background-task-definition';
import 'expo-router/entry';
