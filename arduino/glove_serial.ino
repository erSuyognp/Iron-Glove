// Iron Glove — MPU-6050 glove firmware
// Board: Arduino Uno / Nano  (or ESP32: SCL→22, SDA→21)
// Library: Adafruit MPU6050 (install via Arduino IDE Library Manager)
// Wiring (Uno): VCC→3.3V, GND→GND, SCL→A5, SDA→A4

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

Adafruit_MPU6050 mpu;

float pitch = 0;
float roll  = 0;
const float ALPHA = 0.86;
const float DT    = 0.016;   // 60 Hz

void setup() {
  Serial.begin(115200);
  delay(200);
  Wire.begin();

  if (!mpu.begin()) {
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

  // Fist detection: large X acceleration spike
  bool fist = (fabsf(ax) > 1.5f);

  // Output: pitch,roll,ax,ay,az,fist
  Serial.print(pitch, 2);
  Serial.print(',');
  Serial.print(roll, 2);
  Serial.print(',');
  Serial.print(ax, 3);
  Serial.print(',');
  Serial.print(ay, 3);
  Serial.print(',');
  Serial.print(az, 3);
  Serial.print(',');
  Serial.println(fist ? 1 : 0);

  delay(16);   // ~60 Hz
}
