import { logger } from "@/common/logger";
import * as orderbookOrders from "@/jobs/orderbook/orders-queue";
import * as orderbookTokenSets from "@/jobs/orderbook/token-sets-queue";
import * as tokenList from "@/orderbook/token-sets/token-list";

// Version 0.0.1 of Reservoir Protocol Arweave data:
// - `wyvern-v2` legacy orders (not supported anymore)
// - `wyvern-v2.3` orders
// - `list` token sets

export const processTransactionData = async (transactionData: any) => {
  const orderInfos: orderbookOrders.GenericOrderInfo[] = [];
  const tokenSets: tokenList.TokenSet[] = [];

  for (const { kind, data } of transactionData) {
    try {
      switch (kind) {
        case "wyvern-v2.3": {
          orderInfos.push({
            kind: "wyvern-v2.3",
            info: {
              orderParams: data,
              metadata: {
                schemaHash: data.schemaHash,
              },
            },
          });
          break;
        }

        case "token-set": {
          tokenSets.push({
            id: data.id,
            schemaHash: data.schemaHash,
            schema: data.schema,
            contract: data.contract,
            tokenIds: data.tokenIds,
          });
          break;
        }
      }
    } catch {
      // Ignore any errors
    }
  }

  await Promise.all([
    orderbookOrders.addToQueue(orderInfos),
    orderbookTokenSets.addToQueue(tokenSets),
  ]);

  logger.info(
    "process-tranaction-data-v0.0.1",
    `Got ${orderInfos.length} orders from Arweave`
  );
  logger.info(
    "process-tranaction-data-v0.0.1",
    `Got ${tokenSets.length} token sets from Arweave`
  );
};
