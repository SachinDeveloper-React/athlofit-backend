// src/routes/blog.routes.js
const express = require('express');
const router = express.Router();
const {
  getBlogs,
  getBlogCategories,
  getBlogBySlug,
  adminGetBlogs,
  adminGetBlogById,
  adminCreateBlog,
  adminUpdateBlog,
  adminDeleteBlog,
} = require('../controllers/blog.controller');
const { protect, adminOnly } = require('../middleware/auth.middleware');

// ── Admin (must be declared before /:slug to avoid route shadowing) ──────────
router.get('/admin/all',     protect, adminOnly, adminGetBlogs);
router.get('/admin/:id',     protect, adminOnly, adminGetBlogById);
router.post('/admin',        protect, adminOnly, adminCreateBlog);
router.put('/admin/:id',     protect, adminOnly, adminUpdateBlog);
router.delete('/admin/:id',  protect, adminOnly, adminDeleteBlog);

// ── Public ───────────────────────────────────────────────────────────────────
router.get('/',           getBlogs);
router.get('/categories', getBlogCategories);
router.get('/:slug',      getBlogBySlug);

module.exports = router;
