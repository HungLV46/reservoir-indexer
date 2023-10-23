import { BigNumber } from "@ethersproject/bignumber";
import * as Sdk from "@reservoir0x/sdk";
import { HashZero } from "@ethersproject/constants";
import { logger } from "@/common/logger";
import { bn } from "@/common/utils";
import { config } from "@/config/index";
import { Transaction } from "@/models/transactions";
import {
  CollectionMint,
  getCollectionMints,
  simulateAndUpsertCollectionMint,
} from "@/orderbook/mints";
import { AbiParam } from "@/orderbook/mints/calldata";
import { getMaxSupply } from "@/orderbook/mints/calldata/helpers";
import { getMethodSignature } from "@/orderbook/mints/method-signatures";

const STANDARD = "unknown";

export const extractByTx = async (
  collection: string,
  tx: Transaction,
  pricePerAmountMinted: BigNumber,
  amountMinted: BigNumber
): Promise<CollectionMint[]> => {
  const maxSupply = await getMaxSupply(collection);

  if (tx.data.length === 10) {
    return [
      {
        collection,
        contract: collection,
        stage: "public-sale",
        kind: "public",
        status: "open",
        standard: "unknown",
        details: {
          tx: {
            to: tx.to,
            data: {
              signature: tx.data,
              params: [],
            },
          },
        },
        currency: Sdk.Common.Addresses.Native[config.chainId],
        price: pricePerAmountMinted.toString(),
        maxSupply,
      },
    ];
  }

  // Try to get the method signature from the calldata
  const methodSignature = await getMethodSignature(tx.data);
  if (!methodSignature) {
    return [];
  }

  // For now, we only support simple data types in the calldata
  const complexKeywords = ["(", ")", "[", "]", "bytes"];
  const hasComplexArguments = complexKeywords.some((x) => methodSignature.params.includes(x));
  let allBytesIsEmpty = false;

  if (hasComplexArguments) {
    methodSignature.params.split("),").forEach((abiType, i) => {
      const complexParam = complexKeywords.some((c) => abiType.includes(c));
      if (complexParam && abiType.includes("bytes32")) {
        const decodedValue = methodSignature.decodedCalldata[i];
        const subParams = abiType.replace("(", "").split(",");
        allBytesIsEmpty = subParams.every((param, i) => {
          const value = decodedValue[i];
          if (param === "bytes32") {
            return value == HashZero;
          } else if (param === "bytes32[]") {
            return value.length === 0;
          }
        });
      }
    });
    if (!allBytesIsEmpty) {
      return [];
    }
  }
  let rawParams = methodSignature.params.split(",");

  if (hasComplexArguments && allBytesIsEmpty) {
    // (bytes32,bytes32[]),uint256
    rawParams = methodSignature.params.split("),");
    rawParams = rawParams.map((c, index) => (index < rawParams.length - 1 ? `${c})` : c));
  }

  const params: AbiParam[] = [];

  try {
    if (methodSignature.params.length) {
      rawParams.forEach((abiType, i) => {
        const decodedValue = methodSignature.decodedCalldata[i];

        if (abiType.includes("int") && bn(decodedValue).eq(amountMinted)) {
          params.push({
            kind: "quantity",
            abiType,
          });
        } else if (abiType.includes("address") && decodedValue.toLowerCase() === collection) {
          params.push({
            kind: "contract",
            abiType,
          });
        } else if (abiType.includes("address") && decodedValue.toLowerCase() === tx.from) {
          params.push({
            kind: "recipient",
            abiType,
          });
        } else {
          params.push({
            kind: "unknown",
            abiType,
            abiValue: decodedValue.toString().toLowerCase(),
          });
        }
      });
    }
  } catch (error) {
    logger.error("mint-detector", JSON.stringify({ kind: STANDARD, error }));
  }

  const collectionMint: CollectionMint = {
    collection,
    contract: collection,
    stage: "public-sale",
    kind: "public",
    status: "open",
    standard: STANDARD,
    details: {
      tx: {
        to: tx.to,
        data: {
          signature: methodSignature.signature,
          params,
        },
      },
    },
    currency: Sdk.Common.Addresses.Native[config.chainId],
    price: pricePerAmountMinted.toString(),
    maxSupply,
  };

  const results = [collectionMint];

  return results;
};

export const refreshByCollection = async (collection: string) => {
  const existingCollectionMints = await getCollectionMints(collection, { standard: STANDARD });

  // TODO: We should look into re-detecting and updating any fields that
  // could have changed on the mint since the initial detection
  for (const collectionMint of existingCollectionMints) {
    await simulateAndUpsertCollectionMint(collectionMint);
  }
};
