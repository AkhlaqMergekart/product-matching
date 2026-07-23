const axios = require('axios');
const fs = require("fs");
const { appendToFile } = require("./appendToFile");

(async function () {
    try {

        const brandsData = JSON.parse(fs.readFileSync('mumzWorldData_brandIds_2.json', 'utf8'));

        for (var i = 0; i < brandsData.length; i++) {

            const brandId = brandsData[i].id;

            if (brandId == null) continue;

            let hasNext = true;
            let pageNo = 1;

            while (hasNext) {

                let data = JSON.stringify({
                    query: `query GetCategories($countryCode: String, $currentPage: Int! = 1, $filters: ProductAttributeFilterInput!, $pageSize: Int! = 24, $sort: ProductAttributeSortInput) {
  products(
    countryCode: $countryCode
    currentPage: $currentPage
    filter: $filters
    sort: $sort
    pageSize: $pageSize
  ) {
    ...ProductsFragment
  }
}
    
    fragment ProductsFragment on Products {
  items {
    brand
    brand_info {
      is_featured
      title
      url
    }
    categories_without_path_base
    has_options
    id
    is_yalla
    media_gallery_entries {
      id
      disabled
      file
      label
      position
    }
    name
    __typename
    price {
      regularPrice {
        amount {
          currency
          value
        }
      }
    }
    price_range {
      minimum_price {
        discount {
          amount_off
          percent_off
        }
        final_price {
          currency
          value
        }
        regular_price {
          currency
          value
        }
      }
    }
    base_price_range {
      minimum_price {
        final_price {
          currency
          value
        }
        regular_price {
          currency
          value
        }
      }
    }
    usd_price_range {
      minimum_price {
        final_price {
          currency
          value
        }
        regular_price {
          currency
          value
        }
      }
    }
    low_stock_qty
    product_label {
      active_from
      active_to
      background_color
      label_id
      label_text
      name
      text_color
    }
    sku
    small_image {
      url
    }
    color_swatch
    variants {
      attributes {
        code
        uid
        label
        swatch_data {
          value
        }
        value_index
      }
      product {
        id
        is_yalla
        low_stock_qty
        sku
        url_key
        url_suffix
        small_image {
          url
        }
        media_gallery_entries {
          disabled
          file
          id
          label
          position
        }
        name
        sku
        price {
          regularPrice {
            amount {
              currency
              value
            }
          }
        }
        price_range {
          minimum_price {
            discount {
              amount_off
              percent_off
            }
            final_price {
              currency
              value
            }
            regular_price {
              currency
              value
            }
          }
        }
        base_price_range {
          minimum_price {
            final_price {
              currency
              value
            }
            regular_price {
              currency
              value
            }
          }
        }
        usd_price_range {
          minimum_price {
            final_price {
              currency
              value
            }
            regular_price {
              currency
              value
            }
          }
        }
      }
    }
    stock_status
    type_id
    uid
    url_key
    url_suffix
    global_shipping
  }
  page_info {
    total_pages
  }
  total_count
  yalla_total_count
  queryId
}`,
                    variables: { "countryCode": "SA", "currentPage": pageNo, "filters": { "brand": { "eq": brandId } }, "pageSize": 24, "sort": { "position": "ASC", "brand_position": "DESC" } }
                });

                let config = {
                    method: 'post',
                    maxBodyLength: Infinity,
                    url: 'https://catalog.mumzworld.com/graphql?operationName=GetCategories',
                    headers: {
                        'accept': '*/*',
                        'accept-language': 'en-US,en;q=0.9',
                        'catalog-env': 'production',
                        'content-currency': 'SAR',
                        'content-type': 'application/json',
                        'origin': 'https://www.mumzworld.com',
                        'priority': 'u=1, i',
                        'referer': 'https://www.mumzworld.com/',
                        'sec-ch-ua': '"Not;A=Brand";v="99", "Microsoft Edge";v="139", "Chromium";v="139"',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-platform': '"Windows"',
                        'sec-fetch-dest': 'empty',
                        'sec-fetch-mode': 'cors',
                        'sec-fetch-site': 'same-site',
                        'store': 'sa-en',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
                        'user-token': '8544f8ca-55ee-451d-94c8-34569a9a4f5b',
                        'x-app-id': 'nextjs'
                    },
                    data: data
                };

                const response = await axios.request(config);
                console.log("Response for page", pageNo, ":", response.data);
                if (response.data && response.data.data && response.data.data.products && response.data.data.products.items && response.data.data.products.items.length > 0) {
                    const products = response.data.data.products.items?.map(itm => {
                        return {
                            title: itm.name,
                            sku: itm.sku,
                            images: itm.media_gallery_entries?.map(media => "https://www.mumzworld.com/media/catalog/product/cache/abbe87547126054a260ab1dcf2fa50de/" + media.file) || [],
                            price: itm.price_range.minimum_price.final_price.value,
                            mrp: itm.price_range.minimum_price.regular_price.value,
                            url: "https://www.mumzworld.com/sa-en/" + itm.url_key,
                            brand: itm.brand,
                            category: itm.categories_without_path_base?.join(" > "),
                            is_yalla: itm.is_yalla.length > 0 ? true : false,
                            stock_status: itm.stock_status,
                            low_stock_qty: itm.low_stock_qty
                        }
                    });

                    console.log("Products found:", products);

                    await appendToFile("teknum_mumzworld_products.json", products);

                    pageNo++;
                } else {
                    console.log("List Ended");
                    break;
                }
            }

        }

    } catch (err) {
        console.log(err);
    }
}());