// src/controllers/adminFood.controller.js
// ─── Admin CRUD + bulk import for the food catalog ───────────────────────────

const { parse } = require('csv-parse/sync');
const Food = require('../models/Food.model');
const { success, error } = require('../utils/response');

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── GET /admin/foods ─────────────────────────────────────────────────────────
// Paginated, searchable, filterable list for the admin panel.
const getFoods = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search, dietType, category, active } = req.query;
    const filter = {};
    if (active === 'true') filter.isActive = true;
    else if (active === 'false') filter.isActive = false;
    if (dietType) filter.dietType = dietType;
    if (category) filter.category = category;
    if (search) {
      const safe = escapeRegex(search);
      filter.name = { $regex: safe, $options: 'i' };
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(200, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const [foods, total] = await Promise.all([
      Food.find(filter).sort({ name: 1 }).skip(skip).limit(limitNum).lean(),
      Food.countDocuments(filter),
    ]);

    return success(res, 'Foods fetched', {
      foods,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/foods ────────────────────────────────────────────────────────
const createFood = async (req, res, next) => {
  try {
    const food = await Food.create(req.body);
    return success(res, 'Food created', food, 201);
  } catch (err) {
    next(err);
  }
};

// ─── PUT /admin/foods/:id ─────────────────────────────────────────────────────
const updateFood = async (req, res, next) => {
  try {
    const food = await Food.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true },
    );
    if (!food) return error(res, 'Food not found', 404);
    return success(res, 'Food updated', food);
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /admin/foods/:id ──────────────────────────────────────────────────
const deleteFood = async (req, res, next) => {
  try {
    const food = await Food.findByIdAndDelete(req.params.id);
    if (!food) return error(res, 'Food not found', 404);
    return success(res, 'Food deleted', { id: req.params.id });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /admin/foods/:id/toggle ────────────────────────────────────────────
const toggleFood = async (req, res, next) => {
  try {
    const food = await Food.findById(req.params.id);
    if (!food) return error(res, 'Food not found', 404);
    food.isActive = !food.isActive;
    await food.save();
    return success(res, `Food ${food.isActive ? 'activated' : 'deactivated'}`, food);
  } catch (err) {
    next(err);
  }
};

// ─── POST /admin/foods/bulk-upload ────────────────────────────────────────────
// Accepts a CSV file (multipart, field name "file"). Expected columns:
//   name, calories, protein, carbs, fat, fiber, sugar, servingSize,
//   servingUnit, dietType, category, description, imageUrl
//
// - Rows missing required fields are skipped.
// - Duplicate names are upserted (existing record updated).
const bulkUpload = async (req, res, next) => {
  try {
    if (!req.file) return error(res, 'No file uploaded', 400);

    let content = req.file.buffer.toString('utf8');
    // Handle BOM
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

    let records;
    try {
      records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (parseErr) {
      return error(res, `CSV parse error: ${parseErr.message}`, 400);
    }

    if (!records.length) return error(res, 'File is empty or has no valid rows', 400);

    const VALID_DIET = ['veg', 'non-veg', 'vegan'];
    const VALID_CAT = ['breakfast', 'lunch', 'dinner', 'snacks'];
    const VALID_UNIT = ['g', 'ml', 'serving', 'piece'];

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2; // +2 = header row + 0-indexed

      // Required fields
      const name = (row.name || '').trim();
      const calories = parseFloat(row.calories);
      const protein = parseFloat(row.protein);
      const carbs = parseFloat(row.carbs);
      const fat = parseFloat(row.fat);
      const dietType = (row.dietType || row.diet_type || '').trim().toLowerCase();
      const category = (row.category || '').trim().toLowerCase();

      if (!name || isNaN(calories) || isNaN(protein) || isNaN(carbs) || isNaN(fat)) {
        skipped++;
        errors.push(`Row ${rowNum}: missing required field (name/calories/protein/carbs/fat)`);
        continue;
      }
      if (!VALID_DIET.includes(dietType)) {
        skipped++;
        errors.push(`Row ${rowNum}: invalid dietType "${dietType}" (must be veg/non-veg/vegan)`);
        continue;
      }
      if (!VALID_CAT.includes(category)) {
        skipped++;
        errors.push(`Row ${rowNum}: invalid category "${category}" (must be breakfast/lunch/dinner/snacks)`);
        continue;
      }

      const doc = {
        name,
        calories,
        protein,
        carbs,
        fat,
        fiber: row.fiber ? parseFloat(row.fiber) : null,
        sugar: row.sugar ? parseFloat(row.sugar) : null,
        servingSize: row.servingSize ? parseFloat(row.servingSize) : 100,
        servingUnit: VALID_UNIT.includes((row.servingUnit || '').trim().toLowerCase())
          ? row.servingUnit.trim().toLowerCase() : 'g',
        dietType,
        category,
        description: (row.description || '').trim() || null,
        imageUrl: (row.imageUrl || row.image_url || '').trim() || null,
        isActive: true,
      };

      const existing = await Food.findOne({ name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } });
      if (existing) {
        Object.assign(existing, doc);
        await existing.save();
        updated++;
      } else {
        await Food.create(doc);
        created++;
      }
    }

    return success(res, 'Bulk upload complete', {
      total: records.length,
      created,
      updated,
      skipped,
      errors: errors.slice(0, 20), // limit error list to first 20
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getFoods, createFood, updateFood, deleteFood, toggleFood, bulkUpload };
