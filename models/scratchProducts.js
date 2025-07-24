const { sequelize } = require("../database/config.js");
const {
  INTEGER,
  UUID,
  UUIDV4,
  STRING,
  TEXT,
  BOOLEAN,
  ENUM,
  ARRAY,
  JSONB,
  DOUBLE,
  SMALLINT,
  DATE,
} = require("sequelize");

const ScratchProducts = sequelize.define("scratchProducts", {
  id: {
    type: INTEGER,
    autoIncrement: true,
    primaryKey: true,
    allowNull: false, //TODO - required:true
    unique: true,
  },
  uuid: {
    type: UUID,
    defaultValue: UUIDV4,
    underscored: false,
  },
  asin: {
    type: STRING,
    underscored: false,
    allowNull: true,
    defaultValue: null,
  },
  isbn: {
    type: STRING, //TODO - isbn_13
    underscored: false,
    allowNull: true,
    defaultValue: null,
  },
  url: {
    type: TEXT,
    underscored: false,
    allowNull: true,
    defaultValue: null,
  },
  owned: {
    type: BOOLEAN,
    allowNull: true,
    defaultValue: false,
    underscored: false,
  },
  sellerid: {
    type: STRING,
    allowNull: true,
  },
  manufacturelocationandregion: {
    type: STRING,
    allowNull: true,
  },
  itemconditioncode: {
    type: INTEGER,
    allowNull: true,
    defaultValue: null,
  },

  insertionType: {
    type: ENUM(["byId", "byKeyword", "byUrl", "byCategory"]),
    allowNull: true,
    underscored: false,
  },
  isScraped: {
    type: BOOLEAN,
    defaultValue: false,
    underscored: false,
  },
  listingPosition: {
    type: INTEGER,
    defaultValue: null,
    underscored: false,
  },
  domain: {
    type: STRING,
    allowNull: true,
  },
  projectId: {
    type: INTEGER,
    underscored: false,
  },
  bestSellersRank: {
    type: ARRAY(JSONB),
    underscored: false,
    allowNull: true,
  },
  brand: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  manufacturer: {
    type: STRING,
    allowNull: true,
  },
  seller: {
    type: STRING,
    defaultValue: null,
  },
  variant: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  sku: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  categories: {
    type: ARRAY(JSONB),
    allowNull: true,
  },
  category: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  currency: {
    type: STRING,
    allowNull: true,
  },
  image: {
    type: TEXT,
    allowNull: true,
  },
  keywordName: {
    type: ARRAY(STRING),
    underscored: false,
  },
  marketplaceId: {
    type: INTEGER,
    underscored: false,
    allowNull: false,
  },
  price: {
    type: STRING,
    underscored: false,
    defaultValue: null,
  },
  mrp: {
    type: STRING,
    underscored: false,
    defaultValue: null,
  },
  title: {
    type: TEXT,
    underscored: false,
    defaultValue: null,
  },
  rating: {
    type: DOUBLE,
    underscored: false,
  },
  totalRatings: {
    type: DOUBLE,
    underscored: false,
    defaultValue: null,
  },
  otherAttributes: {
    type: JSONB,
    underscored: false,
    allowNull: true,
  },
  variants: {
    type: JSONB,
    underscored: false,
  },
  description: {
    type: TEXT,
    underscored: false,
  },
  bestSellersRank: {
    type: ARRAY(JSONB),
    underscored: false,
  },
  bestSellerRankOne: {
    type: INTEGER,
    underscored: false,
  },
  bestSellerRankCategoryOne: {
    type: TEXT,
    underscored: false,
  },
  bestSellerRankLinkOne: {
    type: STRING,
    underscored: false,
  },
  bestSellerRankTwo: {
    type: INTEGER,
    underscored: false,
  },
  bestSellerRankCategoryTwo: {
    type: TEXT,
    underscored: false,
  },
  bestSellerRankLinkTwo: {
    type: STRING,
    underscored: false,
  },
  bestSellerRankThree: {
    type: INTEGER,
    underscored: false,
  },
  bestSellerRankCategoryThree: {
    type: TEXT,
    underscored: false,
  },
  bestSellerRankLinkThree: {
    type: STRING,
    underscored: false,
  },
  bestSellerRankFour: {
    type: INTEGER,
    underscored: false,
  },
  bestSellerRankCategoryFour: {
    type: TEXT,
    underscored: false,
  },
  bestSellerRankLinkFour: {
    type: STRING,
    underscored: false,
  },
  keyword: {
    type: TEXT, //TODO: Will save the keyword, by which the products are scrap
    underscored: false,
  },
  mainInsertion: {
    type: BOOLEAN,
    allowNull: false,
    defaultValue: false,
    underscored: false,
  },
  otherSellerDetails: {
    type: ARRAY(JSONB), //TODO - more_buying_choices ( Seller Details)
    underscored: false,
    allowNull: true,
    defaultValue: null,
  },
  dateOflaunch: {
    type: DATE, //TODO - first_available
    underscored: false,
    allowNull: true,
    defaultValue: null,
  },
  attributes: {
    type: ARRAY(JSONB),
    underscored: false,
    allowNull: true,
    defaultValue: null,
  },
  variantIds: {
    type: ARRAY(STRING), //TODO - variants.asin
    underscored: false,
    allowNull: true,
    defaultValue: null,
  },
  size: {
    type: INTEGER,
    underscored: false,
    allowNull: true,
    defaultValue: null,
  },
  status: {
    type: SMALLINT,
    defaultValue: 1,
  },
  images: {
    type: ARRAY(TEXT),
    allowNull: true,
    defaultValue: null,
  },
  author: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  publisher: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  language: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  edition: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  pages: {
    type: INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  cover: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  weight: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  origin: {
    type: STRING,
    allowNull: true,
    defaultValue: null,
  },
  nextFetch: {
    type: DATE,
    allowNull: true,
    defaultValue: null,
  },
  scrap_count: {
    type: INTEGER,
    defaultValue: 0,
  },
  pushed_in_queue: {
    type: BOOLEAN,
    defaultValue: false,
  },
  totalReviews: {
    type: STRING,
    defaultValue: 0,
  },
  quantitySold: {
    type: STRING,
  },
  shippingCost: {
    type: STRING,
  },
  itemlocation: {
    type: STRING,
  },
  user_id: {
    type: STRING
  }
});

module.exports = ScratchProducts;
