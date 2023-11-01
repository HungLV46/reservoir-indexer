import { AbstractRabbitMqJobHandler, BackoffStrategy } from "@/jobs/abstract-rabbit-mq-job-handler";
import _ from "lodash";

import { logger } from "@/common/logger";
import { RabbitMQMessage } from "@/common/rabbit-mq";
import { onchainMetadataProvider } from "@/metadata/providers/onchain-metadata-provider";
import { onchainMetadataIndexProcessJob } from "./onchain-metadata-process-job";
import { RequestWasThrottledError } from "@/metadata/providers/utils";
import { PendingFetchOnchainUriTokens } from "@/models/pending-fetch-onchain-uri-tokens";

export default class OnchainMetadataProcessUriJob extends AbstractRabbitMqJobHandler {
  queueName = "metadata-index-onchain-process-uri-queue";
  maxRetries = 3;
  concurrency = 3;
  timeout = 5 * 60 * 1000;
  backoff = {
    type: "exponential",
    delay: 20000,
  } as BackoffStrategy;

  protected async process() {
    const count = 50; // Default number of tokens to fetch

    // Get the onchain tokens from the list
    const fetchTokens = await PendingFetchOnchainUriTokens.get(count);

    // If no more tokens
    if (_.isEmpty(fetchTokens)) {
      return;
    }

    let results;
    try {
      results = await onchainMetadataProvider._getTokensMetadataUri(fetchTokens);
    } catch (e) {
      if (e instanceof RequestWasThrottledError) {
        logger.warn(
          this.queueName,
          `Request was throttled. fetchUriTokenCount=${fetchTokens.length}`
        );

        // Add to queue again with a delay from the error
        await this.addToQueue(e.delay);
        return;
      } else {
        logger.error(this.queueName, `Error. fetchUriTokenCount=${fetchTokens.length}, error=${e}`);
        throw e;
      }
    }

    const tokensToProcess: {
      contract: string;
      tokenId: string;
      uri: string;
      error?: string;
    }[] = [];

    // Filter out tokens that have no metadata
    results.forEach((result) => {
      if (result.uri) {
        tokensToProcess.push(result);
      } else {
        logger.warn(
          this.queueName,
          `No uri found. contract=${result.contract}, tokenId=${result.tokenId}, error=${result.error}`
        );
      }
    });

    await onchainMetadataIndexProcessJob.addToQueueBulk(tokensToProcess);

    // If there are potentially more token uris to process, trigger another job
    const queueLength = await PendingFetchOnchainUriTokens.len();
    if (queueLength > 0) {
      return 1;
    }

    return 0;
  }

  public async onCompleted(rabbitMqMessage: RabbitMQMessage, processResult: undefined | number) {
    if (processResult) {
      await this.addToQueue(processResult * 1000);
    }
  }

  public async addToQueue(delay = 0) {
    await this.send({}, delay);
  }
}

export const onchainMetadataProcessUriJob = new OnchainMetadataProcessUriJob();
