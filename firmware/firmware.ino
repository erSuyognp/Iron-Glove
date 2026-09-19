// D:\iron-glove\firmware\glove.ino
// Board: ESP32S3 Dev Module  (or LilyGO T-Display-S3)
// USB CDC On Boot: Enabled
// Libraries: Adafruit MPU6050, Adafruit Unified Sensor

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

#define I2C_SDA 18
#define I2C_SCL 17
#define PWR_ON  15          // T-Display-S3 peripheral rail
#define MPU_ADDR 0x68       // A0 left open / to GND

Adafruit_MPU6050 mpu;

float pitch = 0;
float roll  = 0;
const float ALPHA = 0.86;
const float DT    = 0.02;

void setup() {
  pinMode(PWR_ON, OUTPUT);
  digitalWrite(PWR_ON, HIGH);

  Serial.begin(115200);
  delay(200);

  Wire.begin(I2C_SDA, I2C_SCL);

  if (!mpu.begin(MPU_ADDR, &Wire)) {
    Serial.println("MPU6050_NOT_FOUND");
    while (1) delay(50);
  }

  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
}

void loop() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  float ax = a.acceleration.x / 9.81f;
  float ay = a.acceleration.y / 9.81f;
  float az = a.acceleration.z / 9.81f;

  float accPitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * 180.0f / PI;
  float accRoll  = atan2f(ay, az) * 180.0f / PI;

  pitch = ALPHA * (pitch + g.gyro.y * (180.0f / PI) * DT) + (1 - ALPHA) * accPitch;
  roll  = ALPHA * (roll  + g.gyro.x * (180.0f / PI) * DT) + (1 - ALPHA) * accRoll;

  Serial.print(pitch, 2);
  Serial.print(',');
  Serial.print(roll, 2);
  Serial.print(',');
  Serial.print(ax, 3);
  Serial.print(',');
  Serial.print(ay, 3);
  Serial.print(',');
  Serial.println(az, 3);

  delay(20);   // 50 Hz
}