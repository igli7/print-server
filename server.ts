// Import necessary modules
import * as Sentry from '@sentry/node';
import cors from 'cors';
import express from 'express';
import * as cputil from 'node-cputil';
import * as redis from 'redis';

// Import the existing router code here (or you can keep it in a separate file and import it)
// Assuming the router code is in a file named 'printRouter.js'

// Initialize Sentry (configure with your DSN)
Sentry.init({ dsn: 'YOUR_SENTRY_DSN' });

// Create an Express app
const app = express();

// Configure middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Redis client
const redisClient = redis.createClient({
  url: 'redis://localhost:6379', // Adjust the URL to your Redis server
});

redisClient.on('error', (err: any) => console.log('Redis Client Error', err));

// Start the Redis client
redisClient.connect();

interface PrintJobType {
  status: string;
  order: string;
}

const fetchPendingJobs = async (printerMAC: string) => {
  let cursor = 0;
  const pendingJobs: string[] = [];

  do {
    // Use scan to get keys in batches
    const reply = await redisClient.scan(cursor, {
      MATCH: `printJob:${printerMAC}:*`,
      COUNT: 100,
    });

    cursor = reply.cursor;
    const keys = reply.keys;

    // Fetch and check each job
    for (const key of keys) {
      const jobDataJson = await redisClient.get(key); // Get the string data
      if (jobDataJson) {
        const jobData = JSON.parse(jobDataJson); // Parse the JSON string
        if (jobData.status === 'PENDING') {
          pendingJobs.push(key);
        }
      }
    }
  } while (cursor !== 0);

  return pendingJobs;
};

const generateReceipt = (printJobs: PrintJobType[]) => {
  let receipts = ``;

  for (const job of printJobs) {
    if (job.status === 'PENDING') {
      const order: any = JSON.parse(job.order);

      let receiptOrder = ``;

      let receiptOrderItems = ``;

      order.orderItems?.forEach((orderItem: any) => {
        receiptOrderItems += `[font: b][magnify: width 2; height 2][column: left ${
          orderItem?.quantity
        }X ${orderItem?.food?.name}; right $${orderItem?.total.toFixed(
          2,
        )}; indent 0][plain]\n`;
        if (orderItem.foodSize) {
          receiptOrderItems += `[bold: on][column: left Size; indent 10%][bold: off]
          [column: left - ${orderItem?.foodSize?.name}; indent 15%]\n`;
        }

        orderItem.optionsGroupedByAddOn?.forEach(
          (optionGroupedByAddOn: any) => {
            receiptOrderItems += `[bold: on][column: left ${optionGroupedByAddOn?.addOnName}; indent 10%][bold: off]\n`;
            optionGroupedByAddOn?.optionsGroupedByOptionSize?.forEach(
              (optionGroupedByOptionSize: any) => {
                receiptOrderItems += `[bold: on][column: left ${optionGroupedByOptionSize?.optionSizeName}; indent 15%][bold: off]\n`;
                optionGroupedByOptionSize?.options?.forEach((option: any) => {
                  receiptOrderItems += `[column: left - ${option?.name}; indent 20%]\n`;
                });
              },
            );
            optionGroupedByAddOn?.options?.forEach((option: any) => {
              receiptOrderItems += `[column: left - ${option?.name}; indent 15%]\n`;
            });
          },
        );
        receiptOrderItems += `\n`;
      });

      receiptOrder = `[align: right]
      Placed on ${order.placementTime}
      [bold: on]\
      [align: center]
      [magnify: width 3; height 3]\
      ${order.guestFirstName} ${order.guestLastName?.charAt(0)}.
      [negative: on]\
      [space: count 1]#${String(order.orderNumber).padStart(
        4,
        '0',
      )}[space: count 1]
      [plain]\
      ${order.guestPhone}
      [underline: on]
      Should be ready ${order.isASAP ? 'by' : 'at'} ${
        order.estimatedCompletionTime
      }
      [plain]
      [upperline: on]
      [space: count 48]
      [plain]\
      [bold: on]
      [magnify: width 2; height 2]\
      ${order.orderType}
      ${
        order.orderType === 'DELIVERY'
          ? ` [plain]
        ${order.deliveryAddress}
        ${order.suiteAptFloor ? order.suiteAptFloor : ''}
        ${order.deliveryDetails ? order.deliveryDetails : ''}`
          : ''
      }[plain]\
      [underline: on]
      [space: count 48]
      [plain]
      [font: a]
      [magnify: width 1; height 1] [align: left] ${receiptOrderItems}[plain]
      ------------------------------------------------
      [column: left Subtotal:; right $${order.subTotal.toFixed(2)}; indent 0]
      [column: left Tax:; right $${order.tax.toFixed(2)}; indent 0]${
        order.deliveryFee
          ? `\n[column: left Delivery Fee:; right $${order.deliveryFee.toFixed(
              2,
            )}; indent 0]`
          : ''
      }
      [column: left Tip:; right $${order.tip.toFixed(2)}; indent 0]
       
      [font: b][magnify: width 2; height 2][column: left Total:; right $${order.total.toFixed(
        2,
      )}; indent 0][plain]
      ------------------------------------------------
      [align: center]
      Thank you! Have a great day!
      [plain]
      [font: b]
      Powered by NexoServe.com
      [plain]
      [cut: feed; partial]
  
      `;

      receipts += receiptOrder;
    }
  }

  return receipts;
};

// POST /print
app.post('/print', async (req, res) => {
  const printersMac = req.headers['x-star-mac'];

  const jobIds = await fetchPendingJobs(printersMac as string);

  console.log('jobIds', jobIds);

  try {
    res.json({
      statusCode: '200 OK',
      // jobReady: jobIds.length > 0 ? true : false,
      jobReady: true,
      jobToken: JSON.stringify(jobIds),
      mediaTypes: ['application/vnd.star.starprnt'],
    });
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
});

// GET /print
app.get('/print', async (req, res) => {
  const jobIds = req.headers['x-star-token'];

  // Check if the printJobsToken is provided and valid
  // if (!jobIds) {
  //   return res.status(400).json({ error: 'No print job token provided' });
  // }

  let printJobs: string[];
  try {
    // Parse the token to get the array of job IDs
    printJobs = JSON.parse(jobIds as string);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }

  const jobsData: PrintJobType[] = [];

  for (const jobId of printJobs) {
    const jobDataJson = await redisClient.get(jobId);
    if (jobDataJson) {
      const jobData: PrintJobType = JSON.parse(jobDataJson);
      jobsData.push(jobData);
    }
  }

  // Define your receipt template using receiptline syntax
  const receipt = generateReceipt(jobsData);

  let convertedData;
  try {
    convertedData = await cputil.default.convertStarPrintMarkUp({
      // text: receipt,
      text: ` ------------------------------------------------
      [align: center]
      Thank you! Have a great day!
      [plain]
      [font: b]
      Powered by NexoServe.com
      [plain]
      [cut: feed; partial]`,
      contentType: cputil.default.StarContentType.STAR_VND_PRNT,
      printerType: cputil.default.StarPrinterType.THERMAL_3,
    });
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }

  res.setHeader('Content-Type', 'application/vnd.star.starprnt');
  res.setHeader('Content-Length', Buffer.from(convertedData).length);
  res.send(convertedData);
});

app.delete('/print', async (req, res) => {
  const jobIds = req.headers['x-star-token'];

  let printJobs: string[];
  try {
    // Parse the token to get the array of job IDs
    printJobs = JSON.parse(jobIds as string);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }

  for (const key of printJobs) {
    try {
      // Delete the record by key
      await redisClient.del(key);
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  }

  res.json({
    statusCode: '200 OK',
  });
});

// Handle 404 responses
app.use((req, res, next) => {
  res.status(404).send('Sorry, that route does not exist!');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
