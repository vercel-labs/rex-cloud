import { serve } from './helper.js';

serve(process.argv[2], process.argv[3]).catch(() => process.exit(1));
