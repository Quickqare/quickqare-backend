require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("../models/Category");
const SubCategory = require("../models/SubCategory");
const Service = require("../models/service.model");
const defaultServices = require("../admin/data/defaultServices");

const slugify = (value) =>
  String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

async function ensureCategory(categoryCode) {
  const slug = slugify(categoryCode);
  const nameMap = {
    ac: "AC",
    mehendi: "Mehendi",
  };
  const name = nameMap[slug] || String(categoryCode || "").trim();

  let category = await Category.findOne({ $or: [{ slug }, { name }] });
  if (!category) {
    category = await Category.create({
      name,
      slug,
      isActive: true,
    });
  } else if (!category.isActive || category.name !== name || category.slug !== slug) {
    category.name = name;
    category.slug = slug;
    category.isActive = true;
    await category.save();
  }

  return category;
}

async function ensureSubCategory(categoryId, subCategoryName) {
  if (!subCategoryName) {
    return null;
  }

  let subCategory = await SubCategory.findOne({
    category: categoryId,
    name: subCategoryName,
  });

  if (!subCategory) {
    subCategory = await SubCategory.create({
      category: categoryId,
      name: subCategoryName,
      isActive: true,
    });
  } else if (!subCategory.isActive) {
    subCategory.isActive = true;
    await subCategory.save();
  }

  return subCategory;
}

async function upsertService(spec, category, subCategory) {
  const serviceSlug = slugify(spec.name);
  let service = await Service.findOne({
    $or: [
      { slug: serviceSlug },
      { name: new RegExp(`^${String(spec.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
    ],
  });

  if (!service && serviceSlug === "ac-repair") {
    service = await Service.findOne({ name: /^ac repair$/i });
  }

  const payload = {
    name: spec.name,
    slug: serviceSlug,
    description: spec.description || "",
    category: category._id,
    subCategory: subCategory?._id || null,
    legacyCategory: category.slug,
    imageUrl: spec.imageUrl || "",
    price: Number(spec.basePriceInr) || 0,
    commissionPercent: Number(spec.commissionPercent) || 20,
    duration: Math.max(Number(spec.duration) || 60, 1),
    isActive: true,
  };

  if (!service) {
    await Service.create(payload);
    return { action: "created", name: spec.name };
  }

  Object.assign(service, payload);
  await service.save();
  return { action: "updated", name: spec.name };
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const specs = defaultServices.filter((item) =>
    ["ac", "mehendi"].includes(slugify(item.categoryCode))
  );

  const summary = {
    categories: [],
    subCategories: [],
    services: [],
  };

  for (const spec of specs) {
    const category = await ensureCategory(spec.categoryCode);
    const subCategory = await ensureSubCategory(category._id, spec.subCategoryName);
    const serviceResult = await upsertService(spec, category, subCategory);

    summary.categories.push(category.name);
    if (subCategory?.name) {
      summary.subCategories.push(`${category.name}:${subCategory.name}`);
    }
    summary.services.push(`${serviceResult.action}:${spec.name}`);
  }

  console.log(
    JSON.stringify(
      {
        categories: [...new Set(summary.categories)],
        subCategories: [...new Set(summary.subCategories)],
        services: summary.services,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error("syncCustomerCatalog failed:", error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
