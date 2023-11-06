/* eslint-disable @typescript-eslint/no-explicit-any */

import { redb } from "@/common/db";
import { logger } from "@/common/logger";
import { fromBuffer, regex } from "@/common/utils";
import { config } from "@/config/index";
import { getStartTime } from "@/models/top-selling-collections/top-selling-collections";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import Joi from "joi";

import { redis } from "@/common/redis";

const REDIS_EXPIRATION = 60 * 60 * 24; // 24 hours
const REDIS_EXPIRATION_MINTS = 120; // Assuming an hour, adjust as needed.

import { getTrendingMints } from "@/elasticsearch/indexes/activities";

import {
  ElasticMintResult,
  Metadata,
  MetadataKey,
  Mint,
} from "@/api/endpoints/collections/get-trending-mints/interfaces";
import { JoiPrice, getJoiPriceObject } from "@/common/joi";
import { Sources } from "@/models/sources";

const version = "v1";

export const getTrendingMintsV1Options: RouteOptions = {
  description: "Top Trending Mints",
  notes: "Get top trending mints",
  tags: ["api", "mints"],
  plugins: {
    "hapi-swagger": {
      order: 3,
    },
  },
  validate: {
    query: Joi.object({
      period: Joi.string()
        .valid("5m", "10m", "30m", "1h", "2h", "6h", "24h")
        .default("24h")
        .description("Time window to aggregate."),
      type: Joi.string()
        .valid("free", "paid", "any")
        .default("any")
        .description("The type of the mint (free/paid)."),
      limit: Joi.number()
        .integer()
        .min(1)
        .max(50)
        .default(50)
        .description(
          "Amount of items returned in response. Default is 50 and max is 50. Expected to be sorted and filtered on client side."
        ),
    }),
  },
  response: {
    schema: Joi.object({
      mints: Joi.array().items(
        Joi.object({
          id: Joi.string().description("Collection id"),
          name: Joi.string().allow("", null),
          image: Joi.string().allow("", null),
          banner: Joi.string().allow("", null),
          description: Joi.string().allow("", null),
          primaryContract: Joi.string().lowercase().pattern(regex.address),
          creator: Joi.string().allow("", null),
          floorAsk: {
            id: Joi.string().allow(null),
            sourceDomain: Joi.string().allow("", null),
            price: JoiPrice.allow(null),
            maker: Joi.string().lowercase().pattern(regex.address).allow(null),
            validFrom: Joi.number().unsafe().allow(null),
            validUntil: Joi.number().unsafe().allow(null),
            token: Joi.object({
              contract: Joi.string().lowercase().pattern(regex.address).allow(null),
              tokenId: Joi.string().pattern(regex.number).allow(null),
              name: Joi.string().allow(null),
              image: Joi.string().allow("", null),
            })
              .allow(null)
              .description("Lowest Ask Price."),
          },
          createdAt: Joi.date().allow("", null),
          startDate: Joi.date().allow("", null),
          endDate: Joi.date().allow("", null),
          maxSupply: Joi.number().allow(null),
          mintPrice: Joi.number().allow(null),
          mintVolume: Joi.any(),
          mintCount: Joi.number().allow(null),
          mintType: Joi.string().allow("free", "paid", "", null),
          mintStatus: Joi.string().allow("", null),
          mintStages: Joi.array().items(
            Joi.object({
              stage: Joi.string().allow(null),
              tokenId: Joi.string().pattern(regex.number).allow(null),
              kind: Joi.string().required(),
              price: JoiPrice.allow(null),
              startTime: Joi.number().allow(null),
              endTime: Joi.number().allow(null),
              maxMintsPerWallet: Joi.number().unsafe().allow(null),
            })
          ),
          tokenCount: Joi.number().description("Total tokens within the collection."),
          ownerCount: Joi.number().description("Unique number of owners."),
          volumeChange: Joi.object({
            "1day": Joi.number().unsafe().allow(null),
            "7day": Joi.number().unsafe().allow(null),
            "30day": Joi.number().unsafe().allow(null),
            allTime: Joi.number().unsafe().allow(null),
          }).description(
            "Total volume chang e X-days vs previous X-days. (e.g. 7day [days 1-7] vs 7day prior [days 8-14]). A value over 1 is a positive gain, under 1 is a negative loss. e.g. 1 means no change; 1.1 means 10% increase; 0.9 means 10% decrease."
          ),
        })
      ),
    }).label(`get-trending-mints${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-trending-mints-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async ({ query }: Request, h) => {
    const { normalizeRoyalties, useNonFlaggedFloorAsk, type, period, limit } = query;

    try {
      const mintingCollections = await getMintingCollections(type);

      const elasticMintData = await getTrendingMints({
        contracts: mintingCollections.map(({ collection_id }) => collection_id),
        startTime: getStartTime(period),
        limit,
      });

      const collectionsMetadata = await getCollectionsMetadata(
        elasticMintData.map((res) => res.id)
      );

      const mints = await formatCollections(
        mintingCollections,
        elasticMintData,
        collectionsMetadata,
        normalizeRoyalties,
        useNonFlaggedFloorAsk
      );
      const response = h.response({ mints });
      return response;
    } catch (error) {
      logger.error(`get-trending-mints-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};

async function getMintingCollections(type: "paid" | "free" | "any"): Promise<Mint[]> {
  const cacheKey = `minting-collections-cache:v1:${type}`;

  const cachedResult = await redis.get(cacheKey);
  if (cachedResult) {
    return JSON.parse(cachedResult);
  }

  const conditions: string[] = [];
  conditions.push(`kind = 'public'`, `status = 'open'`);
  type && type !== "any" && conditions.push(`price ${type === "free" ? "= 0" : "> 0"}`);

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const baseQuery = `
SELECT 
    collection_id, start_time, end_time, created_at, updated_at, max_supply, max_mints_per_wallet, price
FROM 
    collection_mints 
${whereClause}
  `;

  const result = await redb.manyOrNone<Mint>(baseQuery);

  await redis.set(cacheKey, JSON.stringify(result), "EX", REDIS_EXPIRATION_MINTS);

  return result;
}

async function formatCollections(
  mintingCollections: Mint[],
  collectionsResult: ElasticMintResult[],
  collectionsMetadata: Record<string, Metadata>,
  normalizeRoyalties: boolean,
  useNonFlaggedFloorAsk: boolean
): Promise<any[]> {
  const sources = await Sources.getInstance();

  const collections = await Promise.all(
    collectionsResult.map(async (r) => {
      const mintData = mintingCollections.find((c) => c.collection_id == r.id);
      const metadata = collectionsMetadata[r.id];
      let floorAsk;
      let prefix = "";

      if (normalizeRoyalties) {
        prefix = "normalized_";
      } else if (useNonFlaggedFloorAsk) {
        prefix = "non_flagged_";
      }

      const floorAskId = metadata[(prefix + "floor_sell_id") as MetadataKey];
      const floorAskValue = metadata[(prefix + "floor_sell_value") as MetadataKey];
      let floorAskCurrency = metadata[(prefix + "floor_sell_currency") as MetadataKey];
      const floorAskSource = metadata[(prefix + "floor_sell_source_id_int") as MetadataKey];
      const floorAskCurrencyValue =
        metadata[(prefix + `${prefix}floor_sell_currency_value`) as MetadataKey];

      if (metadata) {
        floorAskCurrency = floorAskCurrency
          ? fromBuffer(floorAskCurrency)
          : Sdk.Common.Addresses.Native[config.chainId];
        floorAsk = {
          id: floorAskId,
          sourceDomain: sources.get(floorAskSource)?.domain,
          price: metadata.floor_sell_id
            ? await getJoiPriceObject(
                {
                  gross: {
                    amount: floorAskCurrencyValue ?? floorAskValue,
                    nativeAmount: floorAskValue,
                  },
                },
                floorAskCurrency
              )
            : null,
        };
      }

      return {
        id: r.id,
        banner: metadata.metadata.bannerImageUrl,
        description: metadata.metadata.description,
        image: metadata?.metadata?.imageUrl,
        name: metadata?.name,
        mintType: Number(mintData?.price) > 0 ? "paid" : "free",
        maxSupply: Number.isSafeInteger(mintData?.max_supply) ? mintData?.max_supply : null,
        createdAt: mintData?.created_at && new Date(mintData?.created_at).toISOString(),
        startDate: mintData?.start_time && new Date(mintData?.start_time).toISOString(),
        endDate: mintData?.end_time && new Date(mintData?.end_time).toISOString(),
        mintCount: r.count,
        mintVolume: r.volume,
        mintStages: metadata?.mint_stages
          ? await Promise.all(
              metadata.mint_stages.map(async (m: any) => {
                return {
                  stage: m?.stage || null,
                  kind: m?.kind || null,
                  tokenId: m?.tokenId || null,
                  price: m?.price
                    ? await getJoiPriceObject({ gross: { amount: m.price } }, m.currency)
                    : m?.price,
                  startTime: m?.startTime,
                  endTime: m?.endTime,
                  maxMintsPerWallet: m?.maxMintsPerWallet,
                };
              })
            )
          : [],
        volumeChange: {
          "1day": metadata.day1_volume_change,
          "7day": metadata.day7_volume_change,
          "30day": metadata.day30_volume_change,
          allTime: metadata.all_time_volume,
        },
        tokenCount: Number(metadata.token_count || 0),
        ownerCount: Number(metadata.owner_count || 0),
        floorAsk,
      };
    })
  );

  return collections;
}

async function getCollectionsMetadata(collectionIds: string[]): Promise<Record<string, Metadata>> {
  const collectionsToFetch = collectionIds.map((id: string) => `collection-cache:v1:${id}`);
  const collectionMetadataCache = await redis
    .mget(collectionsToFetch)
    .then((results) =>
      results.filter((result) => !!result).map((result: any) => JSON.parse(result))
    );

  logger.info(
    "top-selling-collections",
    `using ${collectionMetadataCache.length} collections from cache`
  );

  const collectionsToFetchFromDb = collectionIds.filter((id: string) => {
    return !collectionMetadataCache.find((cache: any) => cache.id === id);
  });

  let collectionMetadataResponse: any = [];
  if (collectionsToFetchFromDb.length > 0) {
    logger.info(
      "top-selling-collections",
      `Fetching ${collectionsToFetchFromDb.length} collections from DB`
    );

    const collectionIdList = collectionsToFetchFromDb.map((id: string) => `'${id}'`).join(", ");

    const baseQuery = `
    WITH MintStages AS (
      SELECT 
          collection_id,
          array_agg(
              json_build_object(
                  'stage', stage::TEXT,
                  'tokenId', token_id::TEXT,
                  'kind', kind,
                  'currency', concat('0x', encode(collection_mints.currency, 'hex')),
                  'price', price::TEXT,
                  'startTime', EXTRACT(epoch FROM start_time)::INTEGER,
                  'endTime', EXTRACT(epoch FROM end_time)::INTEGER,
                  'maxMintsPerWallet', max_mints_per_wallet
              )
          ) AS mint_stages
      FROM collection_mints
      WHERE collection_id IN (${collectionIdList})
      GROUP BY collection_id
  )
  SELECT 
      c.id,
      c.name,
      c.contract,
      c.creator,
      c.token_count,
      c.owner_count,
      c.day1_volume_change,
      c.day7_volume_change,
      c.day30_volume_change,
      c.all_time_volume,
      json_build_object(
          'imageUrl', c.metadata ->> 'imageUrl',
          'bannerImageUrl', c.metadata ->> 'bannerImageUrl',
          'description', c.metadata ->> 'description'
      ) AS metadata,
      c.non_flagged_floor_sell_id,
      c.non_flagged_floor_sell_value,
      c.non_flagged_floor_sell_maker,
      c.non_flagged_floor_sell_valid_between,
      c.non_flagged_floor_sell_source_id_int,
      c.floor_sell_id,
      c.floor_sell_value,
      c.floor_sell_maker,
      c.floor_sell_valid_between,
      c.floor_sell_source_id_int,
      c.normalized_floor_sell_id,
      c.normalized_floor_sell_value,
      c.normalized_floor_sell_maker,
      c.normalized_floor_sell_valid_between,
      c.normalized_floor_sell_source_id_int,
      c.top_buy_id,
      c.top_buy_value,
      c.top_buy_maker,
      c.top_buy_valid_between,
      c.top_buy_source_id_int,
      ms.mint_stages
  FROM collections c
  LEFT JOIN MintStages ms ON c.id = ms.collection_id
  WHERE c.id IN (${collectionIdList});  
  `;

    collectionMetadataResponse = await redb.manyOrNone(baseQuery);

    const redisMulti = redis.multi();

    for (const metadata of collectionMetadataResponse) {
      redisMulti.set(`collection-cache:v1:${metadata.id}`, JSON.stringify(metadata));
      redisMulti.expire(`collection-cache:v1:${metadata.id}`, REDIS_EXPIRATION);
    }
    await redisMulti.exec();
  }

  const collectionsMetadata: Record<string, Metadata> = {};

  [...collectionMetadataResponse, ...collectionMetadataCache].forEach((metadata: any) => {
    collectionsMetadata[metadata.id] = metadata;
  });

  return collectionsMetadata;
}
