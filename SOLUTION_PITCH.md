# BolBahi — Voice-First Order Management for Kirana Shops

**Problem**  
Small kirana shops often receive customer orders verbally, over calls, or through informal conversations. Manually entering these orders can be slow and may lead to mistakes in product names, quantities, and totals.

**Our Solution**  
BolBahi is a voice-first order management application designed for Indian kirana shops. Shopkeepers can speak naturally in Hindi or Hinglish instead of typing every order.

**How It Works**
1. The shopkeeper speaks an order, such as “Do kilo chawal aur ek litre tel.”
2. Gnani Speech-to-Text converts the audio into text.
3. BolBahi identifies supported products and quantities and prepares an editable order.
4. The shopkeeper can make spoken quantity corrections, review the order, and hear it read back using Gnani Text-to-Speech.
5. The shopkeeper explicitly confirms the order and receives a saved receipt in order history.

**Technology**
- Frontend: React and Vite, hosted on AWS Amplify.
- Backend: Node.js and Express on AWS Lambda, exposed through API Gateway.
- Storage: Amazon DynamoDB.
- Voice: Gnani Prisma Speech-to-Text and Gnani Timbre Text-to-Speech.

**What Makes It Useful**  
BolBahi focuses on a familiar interaction for kirana shopkeepers: speaking an order in their own language. Editable review and explicit confirmation keep the shopkeeper in control instead of automatically accepting a possibly incorrect transcription.

**Project Links**  
- Live Demo: https://main.d2cca99agmgj8e.amplifyapp.com  
- GitHub: https://github.com/aditya052003/bolbahi  
- Video Demo: https://youtu.be/LXRTGq9a8RY
