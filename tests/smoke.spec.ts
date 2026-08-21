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

test('学生端手机宽度不产生整页横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/gan-schedule/#/student');
  await expect(page.getByRole('heading', { name: '学生排课信息登记' })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
});

test('未登录教师看不到任何学生资料', async ({ page }) => {
  await page.goto('/gan-schedule/#/teacher');
  await expect(page.getByRole('heading', { name: '教师端登录' })).toBeVisible();
  await expect(page.getByText('学生提交待审核')).toHaveCount(0);
  await expect(page.getByText('自动组班')).toHaveCount(0);
});
