// src/controllers/blog.controller.js
const Blog = require("../models/Blog.model");
const { success, error } = require("../utils/response");
const { uploadImage, deleteImage } = require("../utils/uploadImage");

// BUG-safe regex escaping for search
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── GET /blog ────────────────────────────────────────────────────────────────
// Public: list published blogs. Query: ?page=1&limit=9&category=&search=&tag=
const getBlogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 9, category, search, tag } = req.query;

    const filter = { isPublished: true };
    if (category && category !== "all") filter.category = category;
    if (tag) filter.tags = { $in: [tag] };
    if (search) {
      const safe = escapeRegex(search);
      filter.$or = [
        { title: { $regex: safe, $options: "i" } },
        { excerpt: { $regex: safe, $options: "i" } },
        { tags: { $in: [new RegExp(safe, "i")] } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .select("-content")
        .sort({ publishedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Blog.countDocuments(filter),
    ]);

    return success(res, "Blogs fetched", {
      blogs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        hasMore: pageNum < Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /blog/categories ──────────────────────────────────────────────────────
// Public: distinct categories of published blogs.
const getBlogCategories = async (req, res, next) => {
  try {
    const categories = await Blog.distinct("category", { isPublished: true });
    return success(res, "Blog categories fetched", categories);
  } catch (err) {
    next(err);
  }
};

// ─── GET /blog/:slug ────────────────────────────────────────────────────────────
// Public: fetch a single published blog by slug + increment views.
const getBlogBySlug = async (req, res, next) => {
  try {
    const { slug } = req.params;

    const blog = await Blog.findOneAndUpdate(
      { slug, isPublished: true },
      { $inc: { views: 1 } },
      { new: true },
    );

    if (!blog) return error(res, "Blog post not found", 404);

    // Fetch up to 3 related posts in the same category
    const related = await Blog.find({
      isPublished: true,
      category: blog.category,
      _id: { $ne: blog._id },
    })
      .select("title slug excerpt coverImage category readTime publishedAt")
      .sort({ publishedAt: -1 })
      .limit(3);

    return success(res, "Blog fetched", { blog, related });
  } catch (err) {
    next(err);
  }
};

// ─── Admin: GET /blog/admin/all ─────────────────────────────────────────────────
// Lists all blogs (published + drafts) for the admin panel.
const adminGetBlogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status === "published") filter.isPublished = true;
    if (status === "draft") filter.isPublished = false;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const [blogs, total] = await Promise.all([
      Blog.find(filter)
        .select("-content")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Blog.countDocuments(filter),
    ]);

    return success(res, "Blogs fetched", {
      blogs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Admin: GET /blog/admin/:id ─────────────────────────────────────────────────
const adminGetBlogById = async (req, res, next) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return error(res, "Blog post not found", 404);
    return success(res, "Blog fetched", blog);
  } catch (err) {
    next(err);
  }
};

// ─── Admin: POST /blog/admin ────────────────────────────────────────────────────
const adminCreateBlog = async (req, res, next) => {
  try {
    const {
      title, content, excerpt, coverImage, category, tags,
      author, metaTitle, metaDescription, isPublished,
    } = req.body;

    if (!title || !content) {
      return error(res, "title and content are required", 400);
    }

    // Cover image: prefer an uploaded file, fall back to a provided URL.
    let coverImageUrl = coverImage || "";
    if (req.file) {
      coverImageUrl = await uploadImage(req.file, "blogs");
    }

    // tags may arrive as an array (JSON) or comma-separated string (multipart)
    let parsedTags = [];
    if (Array.isArray(tags)) parsedTags = tags;
    else if (typeof tags === "string" && tags.trim())
      parsedTags = tags.split(",").map((t) => t.trim()).filter(Boolean);

    const blog = await Blog.create({
      title,
      content,
      excerpt,
      coverImage: coverImageUrl,
      category,
      tags: parsedTags,
      author,
      metaTitle,
      metaDescription,
      isPublished: isPublished === true || isPublished === "true",
    });

    return success(res, "Blog created", blog, 201);
  } catch (err) {
    next(err);
  }
};

// ─── Admin: PUT /blog/admin/:id ─────────────────────────────────────────────────
const adminUpdateBlog = async (req, res, next) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return error(res, "Blog post not found", 404);

    // If a new cover image file was uploaded, push it to S3 and replace.
    if (req.file) {
      const oldImage = blog.coverImage;
      blog.coverImage = await uploadImage(req.file, "blogs");
      // Best-effort cleanup of the previous S3 image.
      if (oldImage) deleteImage(oldImage).catch(() => {});
    } else if (req.body.coverImage !== undefined) {
      blog.coverImage = req.body.coverImage;
    }

    // Normalize tags (array or comma-separated string)
    if (req.body.tags !== undefined) {
      if (Array.isArray(req.body.tags)) blog.tags = req.body.tags;
      else if (typeof req.body.tags === "string")
        blog.tags = req.body.tags.split(",").map((t) => t.trim()).filter(Boolean);
    }

    if (req.body.isPublished !== undefined) {
      blog.isPublished = req.body.isPublished === true || req.body.isPublished === "true";
    }

    const fields = [
      "title", "content", "excerpt", "category",
      "author", "metaTitle", "metaDescription",
    ];
    for (const f of fields) {
      if (req.body[f] !== undefined) blog[f] = req.body[f];
    }

    await blog.save(); // triggers slug + readTime + publishedAt hooks
    return success(res, "Blog updated", blog);
  } catch (err) {
    next(err);
  }
};

// ─── Admin: DELETE /blog/admin/:id ──────────────────────────────────────────────
const adminDeleteBlog = async (req, res, next) => {
  try {
    const blog = await Blog.findByIdAndDelete(req.params.id);
    if (!blog) return error(res, "Blog post not found", 404);
    // Best-effort cleanup of the cover image from S3.
    if (blog.coverImage) deleteImage(blog.coverImage).catch(() => {});
    return success(res, "Blog deleted", { id: req.params.id });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getBlogs,
  getBlogCategories,
  getBlogBySlug,
  adminGetBlogs,
  adminGetBlogById,
  adminCreateBlog,
  adminUpdateBlog,
  adminDeleteBlog,
};
