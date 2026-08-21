import { test, expect } from '@playwright/test';

test('学生端入口可加载', async ({ page }) => {
  await page.goto('/gan-schedule/');
  await expect(page.getByText('学生入口')).toBeVisible();
  await expect(page.getByRole('heading', { name: '学生排课信息登记' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '学生登录' })).toBeVisible();
});

test('教师端路由可以打开', async ({ page }) => {
  await page.goto('/gan-schedule/#/teacher');
  await expect(page.getByRole('link', { name: '教师端' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '教师端登录' })).toBeVisible();
});
